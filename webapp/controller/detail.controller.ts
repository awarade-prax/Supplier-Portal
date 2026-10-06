import Controller from "sap/ui/core/mvc/Controller";
import UIComponent from "sap/ui/core/UIComponent";
import JSONModel from "sap/ui/model/json/JSONModel";
import ODataModel from "sap/ui/model/odata/v2/ODataModel";
import Filter from "sap/ui/model/Filter";
import FilterOperator from "sap/ui/model/FilterOperator";
import MessageBox from "sap/m/MessageBox";
import MessageToast from "sap/m/MessageToast";
import Dialog from "sap/m/Dialog";
import Button from "sap/m/Button";
import TextArea from "sap/m/TextArea";
import { ButtonType } from "sap/m/library";
import { ValueState } from "sap/ui/core/library";
import Event from "sap/ui/base/Event";
import Context from "sap/ui/model/odata/v2/Context";
import { Route$PatternMatchedEvent } from "sap/ui/core/routing/Route";
import History from "sap/ui/core/routing/History";
import formatter from "../model/formatter";
import { createSupplierInSAP } from "../model/businessPartner";

// child key in the "child" JSON model -> OData entity set
const CHILD_SETS: Record<string, string> = {
    general: "YY1_SUPPLIERGENERALDATA_SUPPLI",
    tax: "YY1_TAXREGISTRATION_SUPPLIER_O",
    bank: "YY1_BANKDATA_SUPPLIER_ONBOARDI",
    contact: "YY1_PURCHASECONTACT_SUPPLIER_O",
    docs: "YY1_DOCUMENTS_SUPPLIER_ONBOARD"
};

// current Status code -> (decision -> new Status code)
//   3 = Under Review of Purchase -> 4 Approved / 5 Rejected / 6 Sent Back by Purchase
//   7 = Under Review of Finance  -> 8 Approved / 9 Rejected / 10 Sent Back by Finance
// NOTE: 8 is converted to 11 (Overall Approved) by custom backend logic.
const TRANSITIONS: Record<string, Record<string, { code: string; text: string }>> = {
    "3": {
        "Approved": { code: "4", text: "Approved by Purchase" },
        "Rejected": { code: "5", text: "Rejected by Purchase" },
        "Sent Back": { code: "6", text: "Sent Back by Purchase" }
    },
    "7": {
        "Approved": { code: "8", text: "Approved by Finance" },
        "Rejected": { code: "9", text: "Rejected by Finance" },
        "Sent Back": { code: "10", text: "Sent Back by Finance" }
    }
};

// Where the action is logged, depending on the status the onboarding is in.
// Both entity sets are child nodes, so rows are created through the parent's navigation property.
// The comment field is named differently per entity set (PurchaseApprComment / FinanceApprComment).
const APPROVAL_TARGET: Record<string, { navigation: string; entitySet: string; commentField: string }> = {
    "3": { navigation: "to_PurchaseApproval", entitySet: "YY1_PURCHASEAPPROVAL_SUPPLI000", commentField: "PurchaseApprComment" },
    "7": { navigation: "to_FinanceApproval", entitySet: "YY1_FINANCEAPPROVAL_SUPPLIER_O", commentField: "FinanceApprComment" }
};

// value of the approval row's Status field per decision (service value list: 01 PENDING, 02 APPROVED, 03 REJECTED)
const APPROVAL_STATUS: Record<string, string> = { "Approved": "02", "Rejected": "03", "Sent Back": "01" };
const DECISION_LABEL: Record<string, string> = { "Approved": "Approve", "Rejected": "Reject", "Sent Back": "Send Back" };

const MAX_COMMENT_LENGTH = 500;
const MAX_USER_LENGTH = 50;

/**
 * @namespace supplierportal.controller
 */
export default class detail extends Controller {
    public formatter = formatter;
    private _id = "";

    public onInit(): void {
        this.getView()!.setModel(new JSONModel(this._emptyChildren()), "child");
        // Approve / Reject / Send Back are only offered when opened from the Purchase / Finance tabs
        // (and only while the record is in a "Under Review" status - see the view)
        this.getView()!.setModel(new JSONModel({ allowed: true }), "ui");
        const router = UIComponent.getRouterFor(this);
        router.getRoute("detail")!.attachPatternMatched(this._onMatched, this);
        router.getRoute("allDetail")!.attachPatternMatched(this._onMatched, this);
    }

    private _emptyChildren(): Record<string, object> {
        return { general: {}, tax: {}, bank: {}, contact: {}, docs: {} };
    }

    private _onMatched(e: Route$PatternMatchedEvent): void {
        const args = e.getParameter("arguments") as { id: string };
        this._id = args.id;
        (this.getView()!.getModel("ui") as JSONModel).setProperty("/allowed", e.getParameter("name") !== "allDetail");

        const model = this.getView()!.getModel() as ODataModel;
        (this.getView()!.getModel("child") as JSONModel).setData(this._emptyChildren());

        model.metadataLoaded().then(() => {
            const path = "/" + model.createKey("YY1_SUPPLIER_ONBOARDING", { SAP_UUID: this._id });
            this.getView()!.bindElement({ path });
            Object.keys(CHILD_SETS).forEach((key) => this._loadChild(key, CHILD_SETS[key]));
        });
    }

    private _loadChild(key: string, entitySet: string): void {
        const model = this.getView()!.getModel() as ODataModel;
        const child = this.getView()!.getModel("child") as JSONModel;
        model.read("/" + entitySet, {
            filters: [new Filter("SAP_PARENT_UUID", FilterOperator.EQ, this._id)],
            success: (data: any) => child.setProperty("/" + key, data.results?.[0] ?? {}),
            error: () => child.setProperty("/" + key, {})
        });
    }

    public onNavBack(): void {
        if (History.getInstance().getPreviousHash() !== undefined) {
            window.history.go(-1);
            return;
        }
        UIComponent.getRouterFor(this).navTo("list");
    }

    public async onDecision(_e: Event, decision: string): Promise<void> {
        const view = this.getView()!;
        const context = view.getBindingContext() as Context | undefined;
        const current = String(context?.getProperty("Status") ?? "");
        const target = TRANSITIONS[current]?.[decision];
        const approval = APPROVAL_TARGET[current];
        if (!context || !target || !approval) {
            MessageBox.error("This onboarding is not in a status that can be changed.");
            return;
        }

        const comment = await this._askForComment(`${DECISION_LABEL[decision]} - ${target.text}`);
        if (comment === null) { return; } // cancelled

        const model = view.getModel() as ODataModel;
        const supplierId = String(context.getProperty("ID") ?? "");
        // Finance approval = final approval -> supplier must be created in SAP first
        const createInSap = current === "7" && decision === "Approved";
        let sapStepFailed = false;
        let approvalSaved = false;
        let bpNumber = "";

        view.setBusy(true);
        try {
            // 0) Finance approve: post the Business Partner / Supplier to SAP.
            //    If this fails nothing else is saved, so Finance can simply retry.
            if (createInSap) {
                sapStepFailed = true;
                const child = (view.getModel("child") as JSONModel).getData();
                bpNumber = await createSupplierInSAP(view.getModel("bp") as ODataModel, {
                    id: supplierId,
                    name: String(context.getProperty("SupplierName") ?? ""),
                    email: String(context.getProperty("SupplierEmail") ?? ""),
                    purchasingOrg: String(context.getProperty("PurchasingOrganization") ?? ""),
                    general: child.general ?? {},
                    tax: child.tax ?? {},
                    bank: child.bank ?? {}
                });
                sapStepFailed = false;
            }

            const [user, actionId] = await Promise.all([
                this._getCurrentUser(),
                this._nextActionId(approval.entitySet)
            ]);

            // 1) log the action in the Purchase / Finance approval entity set
            const today = new Date();
            await this._create(model, `${context.getPath()}/${approval.navigation}`, {
                ActionID: actionId,
                SupplierID: supplierId,
                ActionTakenBy: user,
                ActionTakenOn: new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())),
                [approval.commentField]: comment,
                Status: APPROVAL_STATUS[decision]
            });
            approvalSaved = true;

            // 2) move the onboarding to its new status (only Status is sent)
            //    Finance approve sends 8; backend logic turns it into 11.
            await this._update(model, context.getPath(), { Status: target.code });

            MessageToast.show(bpNumber
                ? `Onboarding approved. Supplier ${bpNumber} created in SAP.`
                : `Onboarding ${target.text.toLowerCase()}.`);
            this.onNavBack();
        } catch (oError: any) {
            let message = "Could not save the action. Please try again.";
            try {
                message = JSON.parse(oError.responseText)?.error?.message?.value || message;
            } catch (e) {
                message = oError?.message || message;
            }
            if (sapStepFailed) {
                message = `The supplier could not be created in SAP. Nothing was approved - please fix the issue and try again.\n\n${message}`;
            } else if (approvalSaved) {
                message = `Your action was logged, but the onboarding status could not be updated.\n\n${message}`;
            } else if (bpNumber) {
                message = `Supplier ${bpNumber} was created in SAP, but the approval could not be saved. Click Approve again to retry (the existing supplier will be reused).\n\n${message}`;
            }
            MessageBox.error(message);
        } finally {
            view.setBusy(false);
        }
    }

    /** Opens the comment dialog (max 500 chars). Resolves with the comment, or null when cancelled. */
    private _askForComment(title: string): Promise<string | null> {
        return new Promise((resolve) => {
            const textArea = new TextArea({
                width: "100%",
                rows: 6,
                maxLength: MAX_COMMENT_LENGTH,
                showExceededText: true,
                placeholder: `Enter your comment (maximum ${MAX_COMMENT_LENGTH} characters)`
            });

            const dialog = new Dialog({
                title,
                contentWidth: "30rem",
                content: [textArea],
                beginButton: new Button({
                    text: "Submit",
                    type: ButtonType.Emphasized,
                    press: () => {
                        const value = textArea.getValue();
                        if (value.length > MAX_COMMENT_LENGTH) {
                            textArea.setValueState(ValueState.Error);
                            textArea.setValueStateText(`The comment must not exceed ${MAX_COMMENT_LENGTH} characters.`);
                            return;
                        }
                        resolve(value.trim());
                        dialog.close();
                    }
                }),
                endButton: new Button({
                    text: "Cancel",
                    press: () => { resolve(null); dialog.close(); }
                }),
                afterClose: () => { resolve(null); dialog.destroy(); } // Esc / close
            });
            dialog.addStyleClass("sapUiContentPadding");
            this.getView()!.addDependent(dialog);
            dialog.open();
        });
    }

    /** ActionID is not auto-numbered by the backend: take the current record count + 1 (10 digits). */
    private _nextActionId(entitySet: string): Promise<string> {
        const model = this.getView()!.getModel() as ODataModel;
        return new Promise((resolve, reject) => {
            model.read("/" + entitySet, {
                urlParameters: { "$inlinecount": "allpages", "$top": "1", "$select": "ActionID" },
                success: (data: any) => {
                    const count = Number(data?.__count);
                    if (Number.isNaN(count)) {
                        reject(new Error("Could not determine the number of existing approval records."));
                        return;
                    }
                    resolve(String(count + 1).padStart(10, "0"));
                },
                error: reject
            });
        });
    }

    /** Name of the logged-in user: Fiori launchpad user, else the approuter user-api, else a placeholder. */
    private async _getCurrentUser(): Promise<string> {
        try {
            const container = (window as any).sap?.ushell?.Container;
            if (container) {
                const userInfo = await container.getServiceAsync("UserInfo");
                const user = userInfo.getUser();
                const name = user.getFullName?.() || user.getId?.();
                if (name) { return String(name).slice(0, MAX_USER_LENGTH); }
            }
        } catch (e) {
            // fall through
        }
        try {
            const response = await fetch("/user-api/currentUser");
            if (response.ok) {
                const user = await response.json();
                const name = user.displayName
                    || [user.firstname, user.lastname].filter(Boolean).join(" ")
                    || user.name
                    || user.email;
                if (name) { return String(name).slice(0, MAX_USER_LENGTH); }
            }
        } catch (e) {
            // fall through
        }
        return "Unknown User";
    }

    private _create(model: ODataModel, path: string, data: object): Promise<void> {
        return new Promise((resolve, reject) => {
            model.create(path, data, { success: () => resolve(), error: reject });
        });
    }

    private _update(model: ODataModel, path: string, data: object): Promise<void> {
        return new Promise((resolve, reject) => {
            model.update(path, data, { success: () => resolve(), error: reject });
        });
    }
}
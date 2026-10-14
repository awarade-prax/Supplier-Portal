import Controller from "sap/ui/core/mvc/Controller";
import UIComponent from "sap/ui/core/UIComponent";
import JSONModel from "sap/ui/model/json/JSONModel";
import Filter from "sap/ui/model/Filter";
import FilterOperator from "sap/ui/model/FilterOperator";
import { Route$PatternMatchedEvent } from "sap/ui/core/routing/Route";
import { SmartTable$BeforeRebindTableEvent } from "sap/ui/comp/smarttable/SmartTable";
import ResourceModel from "sap/ui/model/resource/ResourceModel";
import ResourceBundle from "sap/base/i18n/ResourceBundle";
import SmartTable from "sap/ui/comp/smarttable/SmartTable";
import { RowActionItem$PressEvent } from "sap/ui/table/RowActionItem";
import Table from "sap/ui/table/Table";
import Context from "sap/ui/model/Context";
import ODataModel from "sap/ui/model/odata/v2/ODataModel";
import MessageBox from "sap/m/MessageBox";
import MessageToast from "sap/m/MessageToast";
import { createSupplierInSAP } from "../model/businessPartner";
import formatter from "../model/formatter";

interface ODataReadResult {
    results?: Array<Record<string, unknown>>;
    __count?: string;
}

interface ShellUser {
    getFullName?(): string;
    getId?(): string;
}

interface ShellContainer {
    getServiceAsync(service: string): Promise<{ getUser(): ShellUser }>;
}

interface ShellWindow extends Window {
    sap?: { ushell?: { Container?: ShellContainer } };
}

/**
 * Shared by the All, Purchase and Finance tabs. Each tab is its own view instance;
 * the instance configures itself when its own route is matched.
 *
 * @namespace supplierportal.controller
 */
export default class list extends Controller {
    // route name -> title key + the statuses that tab is allowed to show
    private static readonly TAB_CONFIG: Record<string, { titleKey: string; statuses: string[]; detailRoute: string }> = {
        allList: { titleKey: "onboardingsAllTitle", statuses: [], detailRoute: "allDetail" },
        list: { titleKey: "onboardingsPurchaseTitle", statuses: ["3", "4", "5", "6"], detailRoute: "detail" },
        financeList: { titleKey: "onboardingsFinanceTitle", statuses: ["7", "8", "9", "10"], detailRoute: "detail" }
    };

    private static readonly APPROVAL_TARGET: Record<string, { code: string; navigation: string; entitySet: string; commentField: string }> = {
        "3": { code: "4", navigation: "to_PurchaseApproval", entitySet: "YY1_PURCHASEAPPROVAL_SUPPLI000", commentField: "PurchaseApprComment" },
        "7": { code: "8", navigation: "to_FinanceApproval", entitySet: "YY1_FINANCEAPPROVAL_SUPPLIER_O", commentField: "FinanceApprComment" }
    };

    private static readonly FINANCE_CHILD_SETS = {
        general: "YY1_SUPPLIERGENERALDATA_SUPPLI",
        tax: "YY1_TAXREGISTRATION_SUPPLIER_O",
        bank: "YY1_BANKDATA_SUPPLIER_ONBOARDI"
    };

    private static readonly MAX_USER_LENGTH = 50;

    public formatter = formatter;
    private _statuses: string[] | undefined;
    private _detailRoute = "detail";
    private _canApprove = false;

    public onInit(): void {
        this.getView()!.setModel(new JSONModel({ title: "", canApprove: false, hasSelection: false }), "view");

        const router = UIComponent.getRouterFor(this);
        Object.keys(list.TAB_CONFIG).forEach((routeName) => {
            router.getRoute(routeName)!.attachPatternMatched((e: Route$PatternMatchedEvent) => {
                // both routes notify every list instance - only react to our own view
                if (e.getParameter("view") !== this.getView()) { return; }
                this._configure(routeName);
            });
        });
    }

    private _configure(routeName: string): void {
        const cfg = list.TAB_CONFIG[routeName];
        const bundle = (this.getOwnerComponent()!.getModel("i18n") as ResourceModel).getResourceBundle() as ResourceBundle;
        (this.getView()!.getModel("view") as JSONModel).setProperty("/title", bundle.getText(cfg.titleKey));

        this._statuses = cfg.statuses;
        this._detailRoute = cfg.detailRoute;
        this._canApprove = routeName === "list" || routeName === "financeList";
        (this.getView()!.getModel("view") as JSONModel).setProperty("/canApprove", this._canApprove);
        const table = this.byId("onboardingTable") as Table;
        table.clearSelection();
        table.setSelectionMode(this._canApprove ? "MultiToggle" : "None");
        (this.getView()!.getModel("view") as JSONModel).setProperty("/hasSelection", false);
        // (re)load with the status restriction applied
        (this.byId("smartTable") as SmartTable).rebindTable(true);
    }

    public onSelectionChange(): void {
        const table = this.byId("onboardingTable") as Table;
        (this.getView()!.getModel("view") as JSONModel).setProperty(
            "/hasSelection",
            this._canApprove && table.getSelectedIndices().length > 0
        );
    }

    public async onApproveSelected(): Promise<void> {
        const table = this.byId("onboardingTable") as Table;
        const contexts = table.getSelectedIndices()
            .map((index) => table.getContextByIndex(index))
            .filter((context): context is Context => Boolean(context));
        if (!contexts.length) {
            MessageBox.information("Select one or more onboarding records to approve.");
            return;
        }

        const expectedStatus = this._statuses?.[0];
        if (!expectedStatus) {
            MessageBox.error("Bulk approval is only available from the Purchase and Finance lists.");
            return;
        }
        const eligible = contexts.filter((context) => String(context.getProperty("Status") ?? "") === expectedStatus);
        const skippedCount = contexts.length - eligible.length;
        if (!eligible.length) {
            MessageBox.information("The selected records are not awaiting approval in this tab.");
            return;
        }

        const model = this.getView()!.getModel() as ODataModel;
        const user = await this._getCurrentUser();
        const failures: string[] = [];
        let approvedCount = 0;
        this.getView()!.setBusy(true);
        try {
            for (const context of eligible) {
                try {
                    await this._approve(context, model, expectedStatus, user);
                    approvedCount++;
                } catch (error) {
                    const id = String(context.getProperty("REQID") || context.getProperty("ID") || "Unknown record");
                    failures.push(`${id}: ${this._errorMessage(error)}`);
                }
            }
        } finally {
            this.getView()!.setBusy(false);
            table.clearSelection();
            (this.getView()!.getModel("view") as JSONModel).setProperty("/hasSelection", false);
            (this.byId("smartTable") as SmartTable).rebindTable(true);
        }

        if (failures.length) {
            const summary = approvedCount
                ? `${approvedCount} record(s) approved successfully.\n`
                : "No records were approved.\n";
            const skipped = skippedCount ? `\n${skippedCount} selected record(s) were skipped because they are not awaiting approval.` : "";
            MessageBox.error(`${summary}${failures.length} record(s) failed:\n${failures.join("\n")}${skipped}`);
        } else {
            const skipped = skippedCount ? ` ${skippedCount} selected record(s) were skipped because they are not awaiting approval.` : "";
            MessageToast.show(`${approvedCount} onboarding record(s) approved.${skipped}`);
        }
    }

    private async _approve(context: Context, model: ODataModel, status: string, user: string): Promise<void> {
        const approval = list.APPROVAL_TARGET[status];
        if (!approval) {
            throw new Error("This onboarding is not awaiting approval.");
        }

        const supplierId = String(context.getProperty("ID") ?? "");
        const isFinance = status === "7";
        let sapStepFailed = false;
        let sapCreationUpdateFailed = false;
        let approvalSaved = false;
        let bpNumber = "";
        let supplierNumber = "";

        try {
            if (isFinance) {
                sapStepFailed = true;
                const [general, tax, bank] = await Promise.all([
                    this._readChild(model, list.FINANCE_CHILD_SETS.general, this._contextId(context)),
                    this._readChild(model, list.FINANCE_CHILD_SETS.tax, this._contextId(context)),
                    this._readChild(model, list.FINANCE_CHILD_SETS.bank, this._contextId(context))
                ]);
                const createdSupplier = await createSupplierInSAP(this.getView()!.getModel("bp") as ODataModel, {
                    id: supplierId,
                    name: String(context.getProperty("SupplierName") ?? ""),
                    email: String(context.getProperty("SupplierEmail") ?? ""),
                    purchasingOrg: String(context.getProperty("PurchasingOrganization") ?? ""),
                    general,
                    tax,
                    bank
                });
                bpNumber = createdSupplier.bpNumber;
                supplierNumber = createdSupplier.supplierNumber;

                sapCreationUpdateFailed = true;
                const sapCreation = await this._readChild(
                    model,
                    "YY1_SAPCREATION_SUPPLIER_ONBOA",
                    this._contextId(context),
                    supplierId
                );
                const sapCreationId = sapCreation.SAP_UUID;
                if (typeof sapCreationId !== "string" || !sapCreationId) {
                    throw new Error(`SAP Creation record was not found for supplier ${supplierId}.`);
                }
                const sapCreationPath = "/" + model.createKey("YY1_SAPCREATION_SUPPLIER_ONBOA", { SAP_UUID: sapCreationId });
                await this._update(model, sapCreationPath, { BPNumber: bpNumber, SupplierNumber: supplierNumber });
                sapCreationUpdateFailed = false;
                sapStepFailed = false;
            }

            const actionId = await this._nextActionId(model, approval.entitySet);
            const today = new Date();
            await this._create(model, `${context.getPath()}/${approval.navigation}`, {
                ActionID: actionId,
                SupplierID: supplierId,
                ActionTakenBy: user,
                ActionTakenOn: new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())),
                [approval.commentField]: "",
                Status: "02"
            });
            approvalSaved = true;
            await this._update(model, context.getPath(), { Status: approval.code });
        } catch (error) {
            let message = this._errorMessage(error);
            if (sapCreationUpdateFailed) {
                message = `Business Partner ${bpNumber} and Supplier ${supplierNumber || bpNumber} were created in SAP, but the SAP Creation record could not be updated. ${message}`;
            } else if (sapStepFailed) {
                message = `The supplier could not be created in SAP. Nothing was approved. ${message}`;
            } else if (approvalSaved) {
                message = `The approval was logged, but the onboarding status could not be updated. ${message}`;
            } else if (bpNumber) {
                message = `Business Partner ${bpNumber} and Supplier ${supplierNumber || bpNumber} were created in SAP, but the approval could not be saved. ${message}`;
            }
            throw new Error(message);
        }
    }

    private _contextId(context: Context): string {
        return String(context.getProperty("SAP_UUID") ?? "");
    }

    private _readChild(model: ODataModel, entitySet: string, parentId: string, supplierId?: string): Promise<Record<string, unknown>> {
        const filters = [new Filter("SAP_PARENT_UUID", FilterOperator.EQ, parentId)];
        if (supplierId) {
            filters.push(new Filter("SupplierID", FilterOperator.EQ, supplierId));
        }
        return new Promise((resolve, reject) => {
            model.read("/" + entitySet, {
                filters,
                success: (data: ODataReadResult) => resolve(data.results?.[0] ?? {}),
                error: reject
            });
        });
    }

    private _nextActionId(model: ODataModel, entitySet: string): Promise<string> {
        return new Promise((resolve, reject) => {
            model.read("/" + entitySet, {
                urlParameters: { "$inlinecount": "allpages", "$top": "1", "$select": "ActionID" },
                success: (data: ODataReadResult) => {
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

    private _getCurrentUser(): Promise<string> {
        return (async () => {
            try {
                const container = (window as ShellWindow).sap?.ushell?.Container;
                if (container) {
                    const userInfo = await container.getServiceAsync("UserInfo");
                    const user = userInfo.getUser();
                    const name = user.getFullName?.() || user.getId?.();
                    if (name) { return String(name).slice(0, list.MAX_USER_LENGTH); }
                }
            } catch {
                // Try the approuter user API when the launchpad service is unavailable.
            }
            try {
                const response = await fetch("/user-api/currentUser");
                if (response.ok) {
                    const currentUser = await response.json() as {
                        displayName?: string; firstname?: string; lastname?: string; name?: string; email?: string
                    };
                    const name = currentUser.displayName
                        || [currentUser.firstname, currentUser.lastname].filter(Boolean).join(" ")
                        || currentUser.name
                        || currentUser.email;
                    if (name) { return String(name).slice(0, list.MAX_USER_LENGTH); }
                }
            } catch {
                // The approval entity accepts the same fallback used by the detail workflow.
            }
            return "Unknown User";
        })();
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

    private _errorMessage(error: unknown): string {
        const responseText = (error as { responseText?: string })?.responseText;
        if (responseText) {
            try {
                const response = JSON.parse(responseText) as { error?: { message?: { value?: string } } };
                return response.error?.message?.value || "Could not save this approval.";
            } catch {
                return responseText;
            }
        }
        return error instanceof Error ? error.message : "Could not save this approval.";
    }

    // Adds the tab's status restriction on top of whatever the filter bar sets
    public onBeforeRebindTable(e: SmartTable$BeforeRebindTableEvent): void {
        const params = e.getParameter("bindingParams") as unknown as { filters: Filter[]; preventTableBind?: boolean };
        if (!this._statuses) {
            // tab not configured yet (initial auto-bind) - wait for the route match
            params.preventTableBind = true;
            return;
        }
        if (!this._statuses.length) { return; } // All Onboardings: no status filter
        params.filters.push(new Filter({
            filters: this._statuses.map((s) => new Filter("Status", FilterOperator.EQ, s)),
            and: false
        }));
    }

    public onRowPress(e: RowActionItem$PressEvent): void {
        const id = e.getParameter("row")?.getBindingContext()?.getProperty("SAP_UUID") as string;
        if (id) {
            UIComponent.getRouterFor(this).navTo(this._detailRoute, { id });
        }
    }
}
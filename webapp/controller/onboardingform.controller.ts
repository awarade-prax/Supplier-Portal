import Controller from "sap/ui/core/mvc/Controller";
import JSONModel from "sap/ui/model/json/JSONModel";
import UIComponent from "sap/ui/core/UIComponent";
import MessageToast from "sap/m/MessageToast";
import MessageBox from "sap/m/MessageBox";
import Input from "sap/m/Input";
import Button from "sap/m/Button";
import { ValueState } from "sap/ui/core/library";
import ODataModel from "sap/ui/model/odata/v2/ODataModel";

// The related entity sets are child nodes of the onboarding business object, so the service
// only allows creating them through the parent's navigation properties
// (POST /YY1_SUPPLIER_ONBOARDING(guid'...')/to_BankData), not directly on the entity set.
// Each one gets a row carrying the generated onboarding ID in SupplierID.
// (Purchase / Finance approval rows are NOT created here - they are created when the
// Purchase / Finance user takes an action on the details page.)
const CHILD_NAVIGATIONS: Record<string, string> = {
    to_BankData: "YY1_BANKDATA_SUPPLIER_ONBOARDI",
    to_Documents: "YY1_DOCUMENTS_SUPPLIER_ONBOARD",
    to_PurchaseContact: "YY1_PURCHASECONTACT_SUPPLIER_O",
    to_SAPCreation: "YY1_SAPCREATION_SUPPLIER_ONBOA",
    to_SupplierGeneralData: "YY1_SUPPLIERGENERALDATA_SUPPLI",
    to_TaxRegistration: "YY1_TAXREGISTRATION_SUPPLIER_O"
};

// Field on YY1_SUPPLIER_ONBOARDING that holds the supplier's invitation token.
// The token is generated here, saved with the record, and put in the mail link:
//   <supplier portal>/?token=<AccessToken>
// The field must be writable (not calculated / read-only) in the custom business object.
const ACCESS_TOKEN_FIELD = "AccessToken";

/**
 * @namespace supplierportal.controller
 */
export default class onboardingform extends Controller {

    public onInit(): void {
        const oOnboardingModel = new JSONModel({
            SupplierName: "",
            SupplierEmail: "",
            PurchasingOrganization: "",
            SupplierCategory: ""
        });
        this.getView()?.setModel(oOnboardingModel, "onboarding");
    }

    public onSubmit(): void {
        const oView = this.getView();
        if (!oView) {
            return;
        }

        if (!this._validateForm()) {
            MessageToast.show((this.getView()?.getModel("i18n") as any)?.getResourceBundle?.()?.getText?.("fieldRequiredMessage") || "Please fill in all mandatory fields.");
            return;
        }

        const oOnboardingModel = oView.getModel("onboarding") as JSONModel;
        const oData = oOnboardingModel.getData();

        // random token, stored in the CBO together with the record and reused in the email link
        const sAccessToken = this._generateToken();

        const oPayload = {
            SupplierName: oData.SupplierName,
            SupplierEmail: oData.SupplierEmail,
            PurchasingOrganization: oData.PurchasingOrganization,
            SupplierCategory: oData.SupplierCategory,
            [ACCESS_TOKEN_FIELD]: sAccessToken
        };

        const oODataModel = oView.getModel() as ODataModel;
        const oSubmitButton = oView.byId("submitButton") as Button;
        oSubmitButton?.setEnabled(false);

        oODataModel.create("/YY1_SUPPLIER_ONBOARDING", oPayload, {
            success: (oCreated: { ID?: string; SAP_UUID?: string; [key: string]: string | undefined }) => {
                const sSupplierId = oCreated?.ID ?? "";

                // mail goes out only after the record (with its token) has been saved
                this._sendConfirmationEmail(oPayload, sAccessToken);

                // post the generated ID into every related entity set
                this._createChildren(sSupplierId, oCreated?.SAP_UUID ?? "").then((aFailed) => {
                    oSubmitButton?.setEnabled(true);
                    if (aFailed.length) {
                        MessageBox.warning(
                            `Onboarding ${sSupplierId} was created, but these related entries could not be created:\n\n${aFailed.join("\n")}`
                        );
                    } else {
                        MessageToast.show(`Supplier onboarding request ${sSupplierId} submitted successfully.`);
                    }
                    this._resetForm();
                    UIComponent.getRouterFor(this).navTo("allList");
                });
            },
            error: (oError: any) => {
                oSubmitButton?.setEnabled(true);
                let sMessage = "Submission failed. Please try again.";
                try {
                    const oErrorResponse = JSON.parse(oError.responseText);
                    sMessage = oErrorResponse?.error?.message?.value || sMessage;
                } catch (e) {
                    // keep default message
                }
                MessageBox.error(sMessage);
            }
        });
    }

    public onCancel(): void {
        this._resetForm();
        UIComponent.getRouterFor(this).navTo("list");
    }

    /** Random, unguessable invitation token (256 bits from the browser's CSPRNG, hex encoded). */
    private _generateToken(): string {
        const bytes = new Uint8Array(32);
        crypto.getRandomValues(bytes);
        return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    }

    /** Creates one row per child node via the parent's navigation properties, with SupplierID = generated onboarding ID.
     *  Resolves with the names of the entity sets that failed. */
    private _createChildren(sSupplierId: string, sParentUuid: string): Promise<string[]> {
        const oODataModel = this.getView()!.getModel() as ODataModel;
        const sParentPath = "/" + oODataModel.createKey("YY1_SUPPLIER_ONBOARDING", { SAP_UUID: sParentUuid });

        const aJobs = Object.keys(CHILD_NAVIGATIONS).map((sNavigation) => new Promise<string | null>((resolve) => {
            oODataModel.create(`${sParentPath}/${sNavigation}`, { SupplierID: sSupplierId }, {
                success: () => resolve(null),
                error: (oError: unknown) => {
                    console.error(`Creating ${CHILD_NAVIGATIONS[sNavigation]} failed:`, oError);
                    resolve(CHILD_NAVIGATIONS[sNavigation]);
                }
            });
        }));

        return Promise.all(aJobs).then((aResults) => aResults.filter((s): s is string => !!s));
    }

    private _sendConfirmationEmail(oPayload: {
        SupplierName: string;
        SupplierEmail: string;
        PurchasingOrganization: string;
        SupplierCategory: string;
    }, sAccessToken: string): void {
        fetch(this.getOwnerComponent()!.getManifestObject().resolveUri("mail-api/send-confirmation"), {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                toEmail: oPayload.SupplierEmail,
                supplierName: oPayload.SupplierName,
                supplierEmail: oPayload.SupplierEmail,
                purchasingOrganization: oPayload.PurchasingOrganization,
                supplierCategory: oPayload.SupplierCategory,
                accessToken: sAccessToken
            })
        })
            .then((oResponse) => {
                if (!oResponse.ok) {
                    throw new Error(`Mail service responded with status ${oResponse.status}`);
                }
                MessageToast.show(`Invitation email sent to ${oPayload.SupplierEmail}.`);
            })
            .catch((oError: unknown) => {
                // The onboarding record was already created successfully, so a mail
                // failure should only be surfaced as a soft warning, not block the flow.
                console.error("Failed to send invitation email:", oError);
                MessageToast.show("Request submitted, but the invitation email could not be sent.");
            });
    }

    private _validateForm(): boolean {
        const oView = this.getView();
        if (!oView) {
            return false;
        }

        let bValid = true;

        const oNameInput = oView.byId("supplierNameInput") as Input;
        const oEmailInput = oView.byId("supplierEmailInput") as Input;

        if (!oNameInput.getValue()?.trim()) {
            oNameInput.setValueState(ValueState.Error);
            bValid = false;
        } else {
            oNameInput.setValueState(ValueState.None);
        }

        const sEmail = oEmailInput.getValue()?.trim();
        const rEmailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!sEmail || !rEmailPattern.test(sEmail)) {
            oEmailInput.setValueState(ValueState.Error);
            bValid = false;
        } else {
            oEmailInput.setValueState(ValueState.None);
        }

        return bValid;
    }

    private _resetForm(): void {
        const oView = this.getView();
        const oOnboardingModel = oView?.getModel("onboarding") as JSONModel;
        oOnboardingModel?.setData({
            SupplierName: "",
            SupplierEmail: "",
            PurchasingOrganization: "",
            SupplierCategory: ""
        });

        const oNameInput = oView?.byId("supplierNameInput") as Input;
        const oEmailInput = oView?.byId("supplierEmailInput") as Input;
        oNameInput?.setValueState(ValueState.None);
        oEmailInput?.setValueState(ValueState.None);
    }
}
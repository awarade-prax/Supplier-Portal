import Controller from "sap/ui/core/mvc/Controller";
import UIComponent from "sap/ui/core/UIComponent";
import JSONModel from "sap/ui/model/json/JSONModel";
import ODataModel from "sap/ui/model/odata/v2/ODataModel";
import MessageBox from "sap/m/MessageBox";
import MessageToast from "sap/m/MessageToast";
import Button from "sap/m/Button";
import Filter from "sap/ui/model/Filter";
import FilterOperator from "sap/ui/model/FilterOperator";
import ResourceModel from "sap/ui/model/resource/ResourceModel";
import ResourceBundle from "sap/base/i18n/ResourceBundle";
import { Route$PatternMatchedEvent } from "sap/ui/core/routing/Route";
import { SmartTable$BeforeRebindTableEvent } from "sap/ui/comp/smarttable/SmartTable";
import SmartTable from "sap/ui/comp/smarttable/SmartTable";
import formatter from "../model/formatter";

interface RfqBidder {
    Supplier?: string;
}

interface SapCreation {
    SupplierNumber?: string;
    SupplierID?: string;
    SAP_PARENT_UUID?: string;
}

interface SupplierOnboarding {
    SAP_UUID?: string;
    ID?: string;
    SupplierEmail?: string;
    AccessToken?: string;
}

/**
 * @namespace supplierportal.controller
 */
export default class rfqdetail extends Controller {
    public formatter = formatter;
    private _rfqNumber = "";

    public onInit(): void {
        this.getView()!.setModel(new JSONModel({ header: {}, items: [], bidders: [] }), "rfqDetail");
        this.getView()!.setModel(this.getOwnerComponent()!.getModel("rfq"));
        UIComponent.getRouterFor(this).getRoute("rfqDetail")!.attachPatternMatched((event) => this._onMatched(event));
    }

    private _onMatched(event: Route$PatternMatchedEvent): void {
        const args = event.getParameter("arguments") as { id: string };
        const view = this.getView()!;
        const model = this.getOwnerComponent()!.getModel("rfq") as ODataModel;
        const detailModel = view.getModel("rfqDetail") as JSONModel;
        this._rfqNumber = args.id;
        detailModel.setData({ header: {}, items: [], bidders: [] });
        view.setBusy(true);

        model.metadataLoaded().then(() => {
            const headerPath = "/" + model.createKey("RFQ_Header", { RequestForQuotation: args.id });
            return this._read(model, headerPath);
        }).then((header) => {
            detailModel.setData({ header, items: [], bidders: [] });
            (this.byId("rfqItemsSmartTable") as SmartTable | undefined)?.rebindTable(true);
            (this.byId("rfqBiddersSmartTable") as SmartTable | undefined)?.rebindTable(true);
        }).catch((error: unknown) => {
            MessageBox.error(this._getErrorMessage(error));
        }).finally(() => {
            view.setBusy(false);
        });
    }

    private _read(model: ODataModel, path: string): Promise<object> {
        return new globalThis.Promise((resolve, reject) => {
            model.read(path, { success: resolve, error: reject });
        });
    }

    private _readCollection<T>(model: ODataModel, path: string, filters: Filter[]): Promise<T[]> {
        return new globalThis.Promise<T[]>((resolve, reject) => {
            model.read(path, {
                filters,
                success: (data: { results?: T[] }) => {
                    if (!Array.isArray(data.results)) {
                        reject(new Error(this._getText("rfqInvalidResponse", [path])));
                        return;
                    }
                    resolve(data.results);
                },
                error: reject
            });
        });
    }

    public onBeforeRebindRfqTable(e: SmartTable$BeforeRebindTableEvent): void {
        const params = e.getParameter("bindingParams") as unknown as { filters: Filter[]; preventTableBind?: boolean };
        if (!this._rfqNumber) {
            params.preventTableBind = true;
            return;
        }
        params.filters.push(new Filter("RequestForQuotation", FilterOperator.EQ, this._rfqNumber));
    }

    private _getText(key: string, argumentsList?: string[]): string {
        const resourceModel = this.getOwnerComponent()!.getModel("i18n") as ResourceModel;
        const bundle = resourceModel.getResourceBundle() as ResourceBundle;
        const text = bundle.getText(key, argumentsList);
        if (text === undefined) {
            throw new Error(`Missing RFQ translation: ${key}`);
        }
        return text;
    }

    private _getErrorMessage(error: unknown): string {
        const baseMessage = this._getText("rfqLoadError");
        if (error instanceof Error) {
            return `${baseMessage}\n${error.message}`;
        }
        if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
            return `${baseMessage}\n${error.message}`;
        }
        return baseMessage;
    }

    public onNavBack(): void {
        UIComponent.getRouterFor(this).navTo("rfqList");
    }

    public async onSendEmails(): Promise<void> {
        const view = this.getView()!;
        const button = this.byId("rfqSendEmailsButton") as Button | undefined;
        const rfqModel = this.getOwnerComponent()!.getModel("rfq") as ODataModel;
        const onboardingModel = this.getOwnerComponent()!.getModel() as ODataModel;
        button?.setEnabled(false);
        view.setBusy(true);

        try {
            const bidderRows = await this._readCollection<RfqBidder>(rfqModel, "/RFQ_Bidder", [
                new Filter("RequestForQuotation", FilterOperator.EQ, this._rfqNumber)
            ]);
            const bidders = new Set<string>();
            bidderRows.forEach((bidder) => {
                const supplierId = bidder.Supplier?.trim();
                if (supplierId) {
                    bidders.add(supplierId);
                }
            });

            if (!bidders.size) {
                MessageToast.show(this._getText("rfqEmailNoBidders"));
                return;
            }

            const results = await globalThis.Promise.all(Array.from(bidders, async (supplierId) => {
                try {
                    const sapCreations = await this._readCollection<SapCreation>(onboardingModel, "/YY1_SAPCREATION_SUPPLIER_ONBOA", [
                        new Filter("SupplierNumber", FilterOperator.EQ, supplierId)
                    ]);
                    const sapCreation = sapCreations.find((record) => record.SupplierNumber?.trim() === supplierId);
                    if (!sapCreation?.SAP_PARENT_UUID || !sapCreation.SupplierID) {
                        throw new Error(this._getText("rfqEmailSapRecordMissing"));
                    }

                    const onboardings = await this._readCollection<SupplierOnboarding>(onboardingModel, "/YY1_SUPPLIER_ONBOARDING", [
                        new Filter("SAP_UUID", FilterOperator.EQ, sapCreation.SAP_PARENT_UUID),
                        new Filter("ID", FilterOperator.EQ, sapCreation.SupplierID)
                    ]);
                    const onboarding = onboardings.find((record) =>
                        record.SAP_UUID === sapCreation.SAP_PARENT_UUID && record.ID === sapCreation.SupplierID
                    );
                    if (!onboarding?.SupplierEmail?.trim() || !onboarding.AccessToken?.trim()) {
                        throw new Error(this._getText("rfqEmailOnboardingDataMissing"));
                    }

                    const quotationDeadline = (view.getModel("rfqDetail") as JSONModel)
                        .getProperty("/header/QuotationDeadline") as Date | string | undefined;
                    const response = await fetch(this.getOwnerComponent()!.getManifestObject().resolveUri("mail-api/send-rfq-invitation"), {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            toEmail: onboarding.SupplierEmail,
                            accessToken: onboarding.AccessToken,
                            rfqNumber: this._rfqNumber,
                            quotationDeadline: quotationDeadline ? this.formatter.odataDate(quotationDeadline) : ""
                        })
                    });
                    if (!response.ok) {
                        throw new Error(`Mail service responded with status ${response.status}`);
                    }
                    return { supplierId, sent: true };
                } catch (error: unknown) {
                    return { supplierId, sent: false, error: this._formatError(error) };
                }
            }));

            const sentCount = results.filter((result) => result.sent).length;
            const failures = results.filter((result) => !result.sent)
                .map((result) => `${result.supplierId}: ${result.error}`);
            if (!failures.length) {
                MessageToast.show(this._getText("rfqEmailsSent", [String(sentCount)]));
            } else if (sentCount) {
                MessageBox.warning(this._getText("rfqEmailsPartial", [String(sentCount), failures.join("\n")]));
            } else {
                MessageBox.error(this._getText("rfqEmailsFailed", [failures.join("\n")]));
            }
        } catch (error: unknown) {
            MessageBox.error(`${this._getText("rfqEmailLookupFailure")}\n${this._formatError(error)}`);
        } finally {
            view.setBusy(false);
            button?.setEnabled(true);
        }
    }

    private _formatError(error: unknown): string {
        if (error instanceof Error) {
            return error.message;
        }
        if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
            return error.message;
        }
        return this._getText("rfqEmailUnknownError");
    }
}
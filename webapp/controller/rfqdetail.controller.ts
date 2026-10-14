import Controller from "sap/ui/core/mvc/Controller";
import UIComponent from "sap/ui/core/UIComponent";
import JSONModel from "sap/ui/model/json/JSONModel";
import ODataModel from "sap/ui/model/odata/v2/ODataModel";
import MessageBox from "sap/m/MessageBox";
import Button from "sap/m/Button";
import Filter from "sap/ui/model/Filter";
import FilterOperator from "sap/ui/model/FilterOperator";
import ResourceModel from "sap/ui/model/resource/ResourceModel";
import ResourceBundle from "sap/base/i18n/ResourceBundle";
import { Route$PatternMatchedEvent } from "sap/ui/core/routing/Route";
import { SmartTable$BeforeRebindTableEvent } from "sap/ui/comp/smarttable/SmartTable";
import SmartTable from "sap/ui/comp/smarttable/SmartTable";
import formatter from "../model/formatter";
import { ValueState } from "sap/ui/core/library";
import {
    getRfqEmailErrorMessage,
    RfqEmailBatchResult,
    sendRfqEmails
} from "../model/rfqEmail";
import { createRfqEmailDialog } from "../model/rfqEmailDialog";

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
        const emailDialog = createRfqEmailDialog((key, args) => this._getText(key, args));
        emailDialog.dialog.open();
        let result: RfqEmailBatchResult = { rfqNumber: this._rfqNumber, recipients: [] };

        try {
            const quotationDeadline = (view.getModel("rfqDetail") as JSONModel)
                .getProperty("/header/QuotationDeadline") as Date | string | undefined;
            result = await sendRfqEmails(
                rfqModel,
                onboardingModel,
                this._rfqNumber,
                quotationDeadline ? this.formatter.odataDate(quotationDeadline) : "",
                this.getOwnerComponent()!.getManifestObject().resolveUri("mail-api/send-rfq-invitation"),
                (progress) => emailDialog.updateProgress(progress, 0, 1),
                (recipient) => emailDialog.setRecipientResult(recipient)
            );
            if (!result.recipients.length) {
                emailDialog.addRfqMessage(
                    this._rfqNumber,
                    this._getText("rfqEmailStatusNotSent"),
                    this._getText("rfqEmailRfqNoBidders", [this._rfqNumber]),
                    ValueState.Warning
                );
            }
        } catch (error: unknown) {
            const message = getRfqEmailErrorMessage(error);
            result = {
                rfqNumber: this._rfqNumber,
                recipients: [],
                error: message
            };
            emailDialog.addRfqMessage(
                this._rfqNumber,
                this._getText("rfqEmailStatusFailed"),
                message,
                ValueState.Error
            );
        } finally {
            const sentCount = result.recipients.filter((recipient) => recipient.sent).length;
            const failedCount = result.recipients.filter((recipient) => !recipient.sent).length + (result.error ? 1 : 0);
            emailDialog.complete(this._getText("rfqEmailBatchSummary", ["1", String(sentCount), String(failedCount)]));
            button?.setEnabled(true);
        }
    }
}
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
import Dialog from "sap/m/Dialog";
import MText from "sap/m/Text";
import ProgressIndicator from "sap/m/ProgressIndicator";
import {
    getRfqEmailErrorMessage,
    RfqEmailBatchResult,
    RfqEmailProgress,
    sendRfqEmails
} from "../model/rfqEmail";

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
        const progressText = new MText({ text: this._getText("rfqEmailProcessingRfq", ["1", "1", this._rfqNumber]) });
        const progressIndicator = new ProgressIndicator({ percentValue: 0, displayValue: "" });
        const dialog = new Dialog({
            title: this._getText("rfqEmailProcessingTitle"),
            contentWidth: "30rem",
            content: [progressText, progressIndicator],
            verticalScrolling: false,
            horizontalScrolling: false
        });
        dialog.open();

        try {
            const quotationDeadline = (view.getModel("rfqDetail") as JSONModel)
                .getProperty("/header/QuotationDeadline") as Date | string | undefined;
            const result = await sendRfqEmails(
                rfqModel,
                onboardingModel,
                this._rfqNumber,
                quotationDeadline ? this.formatter.odataDate(quotationDeadline) : "",
                (progress) => this._updateProgress(progressText, progressIndicator, progress)
            );
            this._showEmailResults([result]);
        } catch (error: unknown) {
            this._showEmailResults([{
                rfqNumber: this._rfqNumber,
                recipients: [],
                error: getRfqEmailErrorMessage(error)
            }]);
        } finally {
            dialog.close();
            dialog.destroy();
            button?.setEnabled(true);
        }
    }

    private _updateProgress(text: MText, indicator: ProgressIndicator, progress: RfqEmailProgress): void {
        text.setText(this._getText("rfqEmailProcessingSupplier", [
            "1",
            "1",
            progress.rfqNumber,
            String(progress.supplierIndex),
            String(progress.supplierCount),
            progress.supplierId
        ]));
        indicator.setPercentValue(Math.round((progress.supplierIndex / progress.supplierCount) * 100));
        indicator.setDisplayValue(`${progress.supplierIndex} / ${progress.supplierCount}`);
    }

    private _showEmailResults(results: RfqEmailBatchResult[]): void {
        const lines: string[] = [];
        let sentCount = 0;
        let failedCount = 0;
        results.forEach((result) => {
            if (result.error) {
                failedCount++;
                lines.push(this._getText("rfqEmailRfqFailed", [result.rfqNumber, result.error]));
            } else if (!result.recipients.length) {
                lines.push(this._getText("rfqEmailRfqNoBidders", [result.rfqNumber]));
            } else {
                result.recipients.forEach((recipient) => {
                    if (recipient.sent) {
                        sentCount++;
                        lines.push(this._getText("rfqEmailRecipientSent", [
                            recipient.rfqNumber,
                            recipient.supplierId,
                            recipient.email ?? ""
                        ]));
                    } else {
                        failedCount++;
                        lines.push(this._getText("rfqEmailRecipientFailed", [
                            recipient.rfqNumber,
                            recipient.supplierId,
                            recipient.email || this._getText("rfqEmailAddressUnavailable"),
                            recipient.error ?? this._getText("rfqEmailUnknownError")
                        ]));
                    }
                });
            }
        });

        const hasWarnings = results.some((result) => !result.error && !result.recipients.length);
        const message = `${this._getText("rfqEmailBatchSummary", [
            String(results.length),
            String(sentCount),
            String(failedCount)
        ])}\n\n${lines.join("\n")}`;
        if (failedCount || hasWarnings) {
            MessageBox.warning(message, { title: this._getText("rfqEmailResultsTitle") });
        } else {
            MessageBox.success(message, { title: this._getText("rfqEmailResultsTitle") });
        }
    }
}
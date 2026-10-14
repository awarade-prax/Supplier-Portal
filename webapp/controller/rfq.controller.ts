import Controller from "sap/ui/core/mvc/Controller";
import UIComponent from "sap/ui/core/UIComponent";
import ODataModel from "sap/ui/model/odata/v2/ODataModel";
import MessageBox from "sap/m/MessageBox";
import Button from "sap/m/Button";
import { ValueState } from "sap/ui/core/library";
import ResourceModel from "sap/ui/model/resource/ResourceModel";
import ResourceBundle from "sap/base/i18n/ResourceBundle";
import { RowActionItem$PressEvent } from "sap/ui/table/RowActionItem";
import Table from "sap/ui/table/Table";
import SmartTable from "sap/ui/comp/smarttable/SmartTable";
import formatter from "../model/formatter";
import {
    getRfqEmailErrorMessage,
    RfqEmailBatchResult,
    sendRfqEmails
} from "../model/rfqEmail";
import { createRfqEmailDialog } from "../model/rfqEmailDialog";

/**
 * @namespace supplierportal.controller
 */
export default class rfq extends Controller {
    public formatter = formatter;

    public onInit(): void {
        this.getView()!.setModel(this.getOwnerComponent()!.getModel("rfq"));
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

    public onSelectionChange(): void {
        const table = (this.byId("rfqSmartTable") as SmartTable).getTable() as Table;
        const button = this.byId("rfqSendEmailsButton") as Button | undefined;
        button?.setEnabled(table.getSelectedIndices().length > 0);
    }

    public onRowPress(event: RowActionItem$PressEvent): void {
        const rfqNumber: unknown = event.getParameter("row")?.getBindingContext()?.getProperty("RequestForQuotation");
        if (typeof rfqNumber === "string" && rfqNumber) {
            UIComponent.getRouterFor(this).navTo("rfqDetail", { id: rfqNumber });
        }
    }

    public async onSendEmails(): Promise<void> {
        const smartTable = this.byId("rfqSmartTable") as SmartTable;
        const table = smartTable.getTable() as Table;
        const selectedIndices = table.getSelectedIndices();
        const rfqRows = selectedIndices.map((index) => table.getContextByIndex(index))
            .filter((context) => context !== null && context !== undefined)
            .map((context) => ({
                rfqNumber: context.getProperty("RequestForQuotation") as string | undefined,
                quotationDeadline: context.getProperty("QuotationDeadline") as Date | string | undefined
            }))
            .filter((row): row is { rfqNumber: string; quotationDeadline: Date | string | undefined } =>
                typeof row.rfqNumber === "string" && !!row.rfqNumber
            );

        if (!rfqRows.length) {
            MessageBox.warning(this._getText("rfqEmailNoSelection"));
            return;
        }

        const button = this.byId("rfqSendEmailsButton") as Button | undefined;
        button?.setEnabled(false);
        const emailDialog = createRfqEmailDialog((key, args) => this._getText(key, args));
        const results: RfqEmailBatchResult[] = [];
        emailDialog.dialog.open();

        try {
            const rfqModel = this.getOwnerComponent()!.getModel("rfq") as ODataModel;
            const onboardingModel = this.getOwnerComponent()!.getModel() as ODataModel;
            for (const [index, row] of rfqRows.entries()) {
                const quotationDeadline = row.quotationDeadline
                    ? this.formatter.odataDate(row.quotationDeadline)
                    : "";
                try {
                    const result = await sendRfqEmails(
                        rfqModel,
                        onboardingModel,
                        row.rfqNumber,
                        quotationDeadline,
                        (progress) => emailDialog.updateProgress(progress, index, rfqRows.length),
                        (recipientResult) => emailDialog.setRecipientResult(recipientResult)
                    );
                    results.push(result);
                    if (!result.recipients.length) {
                        emailDialog.addRfqMessage(
                            row.rfqNumber,
                            this._getText("rfqEmailStatusNotSent"),
                            this._getText("rfqEmailRfqNoBidders", [row.rfqNumber]),
                            ValueState.Warning
                        );
                    }
                } catch (error: unknown) {
                    const message = getRfqEmailErrorMessage(error);
                    results.push({
                        rfqNumber: row.rfqNumber,
                        recipients: [],
                        error: message
                    });
                    emailDialog.addRfqMessage(
                        row.rfqNumber,
                        this._getText("rfqEmailStatusFailed"),
                        message,
                        ValueState.Error
                    );
                }
            }
        } finally {
            table.clearSelection();
            button?.setEnabled(false);
        }

        const sentCount = results.reduce((sum, result) => sum + result.recipients.filter((recipient) => recipient.sent).length, 0);
        const failedCount = results.reduce((sum, result) =>
            sum + result.recipients.filter((recipient) => !recipient.sent).length + (result.error ? 1 : 0), 0);
        emailDialog.complete(this._getText("rfqEmailBatchSummary", [
            String(results.length),
            String(sentCount),
            String(failedCount)
        ]));
    }
}
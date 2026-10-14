import Controller from "sap/ui/core/mvc/Controller";
import UIComponent from "sap/ui/core/UIComponent";
import ODataModel from "sap/ui/model/odata/v2/ODataModel";
import MessageBox from "sap/m/MessageBox";
import Dialog from "sap/m/Dialog";
import MText from "sap/m/Text";
import ProgressIndicator from "sap/m/ProgressIndicator";
import Button from "sap/m/Button";
import ResourceModel from "sap/ui/model/resource/ResourceModel";
import ResourceBundle from "sap/base/i18n/ResourceBundle";
import { RowActionItem$PressEvent } from "sap/ui/table/RowActionItem";
import Table from "sap/ui/table/Table";
import SmartTable from "sap/ui/comp/smarttable/SmartTable";
import formatter from "../model/formatter";
import {
    getRfqEmailErrorMessage,
    RfqEmailBatchResult,
    RfqEmailProgress,
    sendRfqEmails
} from "../model/rfqEmail";

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
        const progressText = new MText({ text: "" });
        const progressIndicator = new ProgressIndicator({ percentValue: 0, displayValue: "" });
        const dialog = new Dialog({
            title: this._getText("rfqEmailProcessingTitle"),
            contentWidth: "30rem",
            content: [progressText, progressIndicator],
            verticalScrolling: false,
            horizontalScrolling: false
        });
        const results: RfqEmailBatchResult[] = [];
        dialog.open();

        try {
            const rfqModel = this.getOwnerComponent()!.getModel("rfq") as ODataModel;
            const onboardingModel = this.getOwnerComponent()!.getModel() as ODataModel;
            for (const [index, row] of rfqRows.entries()) {
                progressText.setText(this._getText("rfqEmailProcessingRfq", [
                    String(index + 1),
                    String(rfqRows.length),
                    row.rfqNumber
                ]));
                const quotationDeadline = row.quotationDeadline
                    ? this.formatter.odataDate(row.quotationDeadline)
                    : "";
                try {
                    const result = await sendRfqEmails(
                        rfqModel,
                        onboardingModel,
                        row.rfqNumber,
                        quotationDeadline,
                        (progress) => this._updateProgress(progressText, progressIndicator, index, rfqRows.length, progress)
                    );
                    results.push(result);
                } catch (error: unknown) {
                    results.push({
                        rfqNumber: row.rfqNumber,
                        recipients: [],
                        error: getRfqEmailErrorMessage(error)
                    });
                }
                progressIndicator.setPercentValue(Math.round(((index + 1) / rfqRows.length) * 100));
                progressIndicator.setDisplayValue(`${index + 1} / ${rfqRows.length}`);
            }
        } finally {
            dialog.close();
            dialog.destroy();
            table.clearSelection();
            button?.setEnabled(false);
        }

        this._showEmailResults(results);
    }

    private _updateProgress(
        text: MText,
        indicator: ProgressIndicator,
        completedRfqs: number,
        totalRfqs: number,
        progress: RfqEmailProgress
    ): void {
        text.setText(this._getText("rfqEmailProcessingSupplier", [
            String(completedRfqs + 1),
            String(totalRfqs),
            progress.rfqNumber,
            String(progress.supplierIndex),
            String(progress.supplierCount),
            progress.supplierId
        ]));
        const percent = ((completedRfqs + progress.supplierIndex / progress.supplierCount) / totalRfqs) * 100;
        indicator.setPercentValue(Math.round(percent));
        indicator.setDisplayValue(`${completedRfqs + 1} / ${totalRfqs}`);
    }

    private _showEmailResults(results: RfqEmailBatchResult[]): void {
        const lines: string[] = [];
        let sentCount = 0;
        let failedCount = 0;
        let hasWarnings = false;
        results.forEach((result) => {
            if (result.error) {
                failedCount++;
                lines.push(this._getText("rfqEmailRfqFailed", [result.rfqNumber, result.error]));
            } else if (!result.recipients.length) {
                hasWarnings = true;
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

        const summary = this._getText("rfqEmailBatchSummary", [
            String(results.length),
            String(sentCount),
            String(failedCount)
        ]);
        const message = `${summary}\n\n${lines.join("\n")}`;
        if (failedCount || hasWarnings) {
            MessageBox.warning(message, { title: this._getText("rfqEmailResultsTitle") });
        } else {
            MessageBox.success(message, { title: this._getText("rfqEmailResultsTitle") });
        }
    }
}
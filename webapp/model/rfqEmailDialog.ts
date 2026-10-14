import Button from "sap/m/Button";
import Column from "sap/m/Column";
import ColumnListItem from "sap/m/ColumnListItem";
import Dialog from "sap/m/Dialog";
import MText from "sap/m/Text";
import ObjectStatus from "sap/m/ObjectStatus";
import ProgressIndicator from "sap/m/ProgressIndicator";
import Table from "sap/m/Table";
import JSONModel from "sap/ui/model/json/JSONModel";
import { ValueState } from "sap/ui/core/library";
import { RfqEmailProgress, RfqEmailRecipientResult } from "./rfqEmail";

interface RfqEmailDialogRow {
    rfqNumber: string;
    supplierId: string;
    status: string;
    state: ValueState;
    message: string;
}

export interface RfqEmailDialog {
    dialog: Dialog;
    updateProgress(progress: RfqEmailProgress, completedRfqs: number, totalRfqs: number): void;
    setRecipientResult(result: RfqEmailRecipientResult): void;
    addRfqMessage(rfqNumber: string, status: string, message: string, state: ValueState): void;
    complete(summary: string): void;
}

export function createRfqEmailDialog(
    getText: (key: string, argumentsList?: string[]) => string
): RfqEmailDialog {
    const progressText = new MText({ text: "" });
    const progressIndicator = new ProgressIndicator({ percentValue: 0, displayValue: "" });
    const model = new JSONModel({ rows: [] as RfqEmailDialogRow[] });
    const table = new Table({
        width: "100%",
        fixedLayout: true,
        growing: true,
        growingThreshold: 8,
        columns: [
            new Column({ width: "10rem", header: new MText({ text: getText("rfqEmailColumnRfq") }) }),
            new Column({ width: "10rem", header: new MText({ text: getText("rfqEmailColumnBidder") }) }),
            new Column({ width: "8rem", header: new MText({ text: getText("rfqEmailColumnStatus") }) }),
            new Column({ header: new MText({ text: getText("rfqEmailColumnMessage") }) })
        ]
    });
    table.setModel(model);
    table.bindItems({
        path: "/rows",
        template: new ColumnListItem({
            cells: [
                new MText({ text: "{rfqNumber}", wrapping: false }),
                new MText({ text: "{supplierId}", wrapping: false }),
                new ObjectStatus({ text: "{status}", state: "{state}" }),
                new MText({ text: "{message}", wrapping: true })
            ]
        })
    });

    let dialog: Dialog;
    const closeButton = new Button({
        text: getText("rfqEmailClose"),
        enabled: false,
        press: () => dialog.close()
    });
    dialog = new Dialog({
        title: getText("rfqEmailProcessingTitle"),
        contentWidth: "60rem",
        contentHeight: "32rem",
        stretchOnPhone: true,
        verticalScrolling: true,
        horizontalScrolling: false,
        content: [progressText, progressIndicator, table],
        endButton: closeButton
    });
    dialog.attachAfterClose(() => dialog.destroy());

    const rowIndices = new Map<string, number>();

    return {
        dialog,
        updateProgress(progress, completedRfqs, totalRfqs) {
            progressText.setText(getText("rfqEmailProcessingSupplier", [
                String(completedRfqs + 1),
                String(totalRfqs),
                progress.rfqNumber,
                String(progress.supplierIndex),
                String(progress.supplierCount),
                progress.supplierId
            ]));
            const percent = ((completedRfqs + progress.supplierIndex / progress.supplierCount) / totalRfqs) * 100;
            progressIndicator.setPercentValue(Math.round(percent));
            progressIndicator.setDisplayValue(`${completedRfqs + 1} / ${totalRfqs}`);

            const key = `${progress.rfqNumber}\u0000${progress.supplierId}`;
            const rows = model.getProperty("/rows") as RfqEmailDialogRow[];
            rowIndices.set(key, rows.length);
            rows.push({
                rfqNumber: progress.rfqNumber,
                supplierId: progress.supplierId,
                status: getText("rfqEmailStatusProcessing"),
                state: ValueState.Information,
                message: getText("rfqEmailMessageSending")
            });
            model.setProperty("/rows", rows);
        },
        setRecipientResult(result) {
            const rowIndex = rowIndices.get(`${result.rfqNumber}\u0000${result.supplierId}`);
            if (rowIndex === undefined) {
                return;
            }
            model.setProperty(`/rows/${rowIndex}/status`, getText(result.sent ? "rfqEmailStatusSuccess" : "rfqEmailStatusFailed"));
            model.setProperty(`/rows/${rowIndex}/state`, result.sent ? ValueState.Success : ValueState.Error);
            model.setProperty(
                `/rows/${rowIndex}/message`,
                result.sent
                    ? getText("rfqEmailMessageSent", [result.email ?? ""])
                    : getText("rfqEmailMessageFailed", [
                        result.email || getText("rfqEmailAddressUnavailable"),
                        result.error ?? getText("rfqEmailUnknownError")
                    ])
            );
        },
        addRfqMessage(rfqNumber, status, message, state) {
            const rows = model.getProperty("/rows") as RfqEmailDialogRow[];
            rows.push({ rfqNumber, supplierId: "-", status, state, message });
            model.setProperty("/rows", rows);
        },
        complete(summary) {
            progressText.setText(summary);
            progressIndicator.setPercentValue(100);
            progressIndicator.setDisplayValue(getText("rfqEmailComplete"));
            dialog.setTitle(getText("rfqEmailResultsTitle"));
            closeButton.setEnabled(true);
        }
    };
}

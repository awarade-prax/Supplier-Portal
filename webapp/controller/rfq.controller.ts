import Controller from "sap/ui/core/mvc/Controller";
import UIComponent from "sap/ui/core/UIComponent";
import { RowActionItem$PressEvent } from "sap/ui/table/RowActionItem";
import formatter from "../model/formatter";

/**
 * @namespace supplierportal.controller
 */
export default class rfq extends Controller {
    public formatter = formatter;

    public onInit(): void {
        this.getView()!.setModel(this.getOwnerComponent()!.getModel("rfq"));
    }

    public onRowPress(event: RowActionItem$PressEvent): void {
        const rfqNumber: unknown = event.getParameter("row")?.getBindingContext()?.getProperty("RequestForQuotation");
        if (typeof rfqNumber === "string" && rfqNumber) {
            UIComponent.getRouterFor(this).navTo("rfqDetail", { id: rfqNumber });
        }
    }
}
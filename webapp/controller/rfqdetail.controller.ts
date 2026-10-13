import Controller from "sap/ui/core/mvc/Controller";
import UIComponent from "sap/ui/core/UIComponent";
import JSONModel from "sap/ui/model/json/JSONModel";
import ODataModel from "sap/ui/model/odata/v2/ODataModel";
import MessageBox from "sap/m/MessageBox";
import Filter from "sap/ui/model/Filter";
import FilterOperator from "sap/ui/model/FilterOperator";
import ResourceModel from "sap/ui/model/resource/ResourceModel";
import ResourceBundle from "sap/base/i18n/ResourceBundle";
import { Route$PatternMatchedEvent } from "sap/ui/core/routing/Route";
import formatter from "../model/formatter";

/**
 * @namespace supplierportal.controller
 */
export default class rfqdetail extends Controller {
    public formatter = formatter;

    public onInit(): void {
        this.getView()!.setModel(new JSONModel({ header: {}, items: [], bidders: [] }), "rfqDetail");
        UIComponent.getRouterFor(this).getRoute("rfqDetail")!.attachPatternMatched((event) => this._onMatched(event));
    }

    private _onMatched(event: Route$PatternMatchedEvent): void {
        const args = event.getParameter("arguments") as { id: string };
        const view = this.getView()!;
        const model = this.getOwnerComponent()!.getModel("rfq") as ODataModel;
        const detailModel = view.getModel("rfqDetail") as JSONModel;
        detailModel.setData({ header: {}, items: [], bidders: [] });
        view.setBusy(true);

        model.metadataLoaded().then(() => {
            const headerPath = "/" + model.createKey("RFQ_Header", { RequestForQuotation: args.id });
            return globalThis.Promise.all([
                this._read(model, headerPath),
                this._readCollection(model, "RFQ_Item", args.id),
                this._readCollection(model, "RFQ_Bidder", args.id)
            ]);
        }).then(([header, items, bidders]) => {
            detailModel.setData({ header, items, bidders });
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

    private async _readCollection(model: ODataModel, entitySet: string, rfqNumber: string): Promise<object[]> {
        const data = await new globalThis.Promise<object>((resolve, reject) => {
            model.read("/" + entitySet, {
                filters: [new Filter("RequestForQuotation", FilterOperator.EQ, rfqNumber)],
                success: resolve,
                error: reject
            });
        });
        const results = "results" in data ? data.results : undefined;
        if (!Array.isArray(results)) {
            throw new Error(this._getText("rfqInvalidResponse", [entitySet]));
        }
        const rows = results.filter((row: unknown): row is object => typeof row === "object" && row !== null);
        if (rows.length !== results.length) {
            throw new Error(this._getText("rfqInvalidResponse", [entitySet]));
        }
        return rows;
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
}

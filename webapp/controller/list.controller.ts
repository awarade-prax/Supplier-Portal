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
import formatter from "../model/formatter";

// route name -> title key + the statuses that tab is allowed to show
const TAB_CONFIG: Record<string, { titleKey: string; statuses: string[]; detailRoute: string }> = {
    allList: { titleKey: "onboardingsAllTitle", statuses: [], detailRoute: "allDetail" },
    list: { titleKey: "onboardingsPurchaseTitle", statuses: ["3", "4", "5", "6"], detailRoute: "detail" },
    financeList: { titleKey: "onboardingsFinanceTitle", statuses: ["7", "8", "9", "10"], detailRoute: "detail" }
};

/**
 * Shared by the All, Purchase and Finance tabs. Each tab is its own view instance;
 * the instance configures itself when its own route is matched.
 *
 * @namespace supplierportal.controller
 */
export default class list extends Controller {
    public formatter = formatter;
    private _statuses: string[] | undefined;
    private _detailRoute = "detail";

    public onInit(): void {
        this.getView()!.setModel(new JSONModel({ title: "" }), "view");

        const router = UIComponent.getRouterFor(this);
        Object.keys(TAB_CONFIG).forEach((routeName) => {
            router.getRoute(routeName)!.attachPatternMatched((e: Route$PatternMatchedEvent) => {
                // both routes notify every list instance - only react to our own view
                if (e.getParameter("view") !== this.getView()) { return; }
                this._configure(routeName);
            });
        });
    }

    private _configure(routeName: string): void {
        const cfg = TAB_CONFIG[routeName];
        const bundle = (this.getOwnerComponent()!.getModel("i18n") as ResourceModel).getResourceBundle() as ResourceBundle;
        (this.getView()!.getModel("view") as JSONModel).setProperty("/title", bundle.getText(cfg.titleKey));

        this._statuses = cfg.statuses;
        this._detailRoute = cfg.detailRoute;
        // (re)load with the status restriction applied
        (this.byId("smartTable") as SmartTable).rebindTable(true);
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
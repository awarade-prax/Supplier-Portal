import Controller from "sap/ui/core/mvc/Controller";
import UIComponent from "sap/ui/core/UIComponent";
import JSONModel from "sap/ui/model/json/JSONModel";
import SideNavigation from "sap/tnt/SideNavigation";
import NavigationListItem from "sap/tnt/NavigationListItem";
import { SideNavigation$ItemSelectEvent } from "sap/tnt/SideNavigation";
import { Router$RouteMatchedEvent } from "sap/ui/core/routing/Router";
import Image from "sap/m/Image";

/**
 * @namespace supplierportal.controller
 */
export default class App extends Controller {

    public onInit(): void {
        // Holds Accept / Reject / Send Back decisions, shared by list + detail views
        this.getOwnerComponent()?.setModel(new JSONModel({}), "decisions");

        (this.byId("headerLogo") as Image).setSrc(
            this.getOwnerComponent()!.getManifestObject().resolveUri("images/logo.png")
        );

        UIComponent.getRouterFor(this).attachRouteMatched((e: Router$RouteMatchedEvent) => {
            const name = e.getParameter("name");
            const nav = this.byId("sideNav") as SideNavigation;
            if (name === "allDetail") {
                nav.setSelectedKey("allList");
                return;
            }
            if (name === "detail") {
                // keep the tab the user came from; default to Purchase on a direct link
                if (!nav.getSelectedKey()) { nav.setSelectedKey("list"); }
                return;
            }
            nav.setSelectedKey(name as string);
        });
    }

    public onItemSelect(e: SideNavigation$ItemSelectEvent): void {
        const key = (e.getParameter("item") as NavigationListItem).getKey();
        UIComponent.getRouterFor(this).navTo(key);
    }
}
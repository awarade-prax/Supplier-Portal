/*global QUnit*/
import Controller from "supplierportal/controller/onboardingform.controller";

QUnit.module("onboardingform Controller");

QUnit.test("I should test the onboardingform controller", function (assert: Assert) {
	const oAppController = new Controller("onboardingform");
	oAppController.onInit();
	assert.ok(oAppController);
});
import ODataModel from "sap/ui/model/odata/v2/ODataModel";
import Filter from "sap/ui/model/Filter";
import FilterOperator from "sap/ui/model/FilterOperator";

/* ------------------------------------------------------------------
 * CONFIG - adjust to your S/4HANA Cloud tenant
 * ------------------------------------------------------------------ */
const BP_CATEGORY = "2";                      // 2 = Organization
const BP_GROUPING = "BP02";                   // grouping that allows external numbering / suppliers
const SUPPLIER_ROLES = ["FLVN00", "FLVN01"];  // FI supplier + purchasing supplier
const DEFAULT_BANK_ID = "0001";

// SAP will NOT create a supplier without a standard address that has a country.
// If the onboarding data has no country, this default is used.
const DEFAULT_COUNTRY = "IN";
const DEFAULT_LANGUAGE = "EN";

/* Possible CBO field names (first one found with a value is used).
 * Add your real CDS field names here if they are not in the lists. */
const FIELDS = {
    country: ["Country", "CountryRegion", "CountryCode", "Land", "SupplierCountry"],
    region: ["Region", "State", "StateCode"],
    city: ["CityName", "City", "Town"],
    postalCode: ["PostalCode", "PostCode", "Pincode", "PinCode", "ZipCode"],
    street: ["StreetName", "Street", "Address", "AddressLine1"],
    houseNo: ["HouseNumber", "HouseNo"],
    phone: ["PhoneNumber", "Phone", "Mobile", "MobileNumber", "TelephoneNumber"],
    taxType: ["TaxCategory", "TaxType", "BPTaxType", "TaxNumberCategory"],
    taxNumber: ["TaxNumber", "TaxNo", "BPTaxNumber", "GSTIN", "PAN", "RegistrationNumber"],
    bankCountry: ["BankCountryKey", "BankCountry", "Country"],
    bankKey: ["BankNumber", "BankKey", "IFSC", "IFSCCode"],
    bankAccount: ["BankAccount", "AccountNumber", "BankAccountNumber"],
    bankHolder: ["BankAccountHolderName", "AccountHolderName", "AccountHolder"],
    iban: ["IBAN"]
};

type Row = Record<string, any>;

export interface OnboardingData {
    id: string;              // generated onboarding ID (stored as external BP number)
    name: string;
    email: string;
    purchasingOrg: string;
    general: Row;
    tax: Row;
    bank: Row;
}

export interface CreatedSupplier {
    bpNumber: string;
    supplierNumber: string;
}

const clip = (v: unknown, n: number): string => String(v ?? "").trim().slice(0, n);

/** first non-empty value among the candidate field names */
function pick(row: Row | undefined, names: string[], max: number): string {
    for (const n of names) {
        const v = clip(row?.[n], max);
        if (v) { return v; }
    }
    return "";
}

/** removes empty values (also in nested objects/arrays) so only available data is posted */
function compact<T>(value: T): T {
    if (Array.isArray(value)) {
        return value.map(compact) as unknown as T;
    }
    if (value && typeof value === "object") {
        const out: Row = {};
        Object.keys(value as Row).forEach((k) => {
            const v = compact((value as Row)[k]);
            const empty = v === "" || v === undefined || v === null
                || (Array.isArray(v) && !v.length);
            if (!empty) { out[k] = v; }
        });
        return out as T;
    }
    return value;
}

function create(model: ODataModel, path: string, data: object): Promise<any> {
    return new Promise((resolve, reject) =>
        model.create(path, data, { success: (d: any) => resolve(d), error: reject }));
}

function read(model: ODataModel, path: string, filters: Filter[]): Promise<any[]> {
    return new Promise((resolve, reject) =>
        model.read(path, { filters, success: (d: any) => resolve(d.results ?? []), error: reject }));
}

/**
 * Creates the Business Partner (with supplier roles and address; bank and tax only when
 * the data is complete) in SAP and adds the purchasing organization to the generated supplier.
 * Safe to retry: if a BP with this onboarding ID already exists it is reused.
 * Rejects on any failure, so the caller can show the error and let Finance retry.
 * Returns the BP and supplier numbers.
 */
export async function createSupplierInSAP(model: ODataModel, d: OnboardingData): Promise<CreatedSupplier> {
    await model.metadataLoaded();

    // idempotency: onboarding ID is saved as external BP number
    const existing = await read(model, "/A_BusinessPartner",
        [new Filter("BusinessPartnerIDByExtSystem", FilterOperator.EQ, clip(d.id, 20))]);
    let bpNumber: string;

    if (existing.length) {
        bpNumber = existing[0].BusinessPartner as string;
    } else {
        const g = d.general, t = d.tax, b = d.bank;
        const country = pick(g, FIELDS.country, 3).toUpperCase() || DEFAULT_COUNTRY;

        const payload: Row = {
            BusinessPartnerCategory: BP_CATEGORY,
            BusinessPartnerGrouping: BP_GROUPING,
            OrganizationBPName1: clip(d.name, 40),
            SearchTerm1: clip(d.name, 20).toUpperCase(),
            BusinessPartnerIDByExtSystem: clip(d.id, 20),
            YY1_Email_ID_bus: clip(d.email, 150),
            to_BusinessPartnerRole: SUPPLIER_ROLES.map((r) => ({ BusinessPartnerRole: r }))
        };

        // standard address is mandatory for a supplier (country is the minimum)
        const phone = pick(g, FIELDS.phone, 30);
        payload.to_BusinessPartnerAddress = [{
            Country: country,
            CityName: pick(g, FIELDS.city, 40),
            PostalCode: pick(g, FIELDS.postalCode, 10),
            StreetName: pick(g, FIELDS.street, 60),
            HouseNumber: pick(g, FIELDS.houseNo, 10),
            Region: pick(g, FIELDS.region, 3),
            Language: DEFAULT_LANGUAGE,
            to_EmailAddress: [{ EmailAddress: clip(d.email, 241), IsDefaultEmailAddress: true }],
            to_PhoneNumber: phone ? [{ PhoneNumber: phone, IsDefaultPhoneNumber: true }] : []
        }];

        // bank: only when account AND bank key are available
        const account = pick(b, FIELDS.bankAccount, 18);
        const bankKey = pick(b, FIELDS.bankKey, 15);
        if (account && bankKey) {
            payload.to_BusinessPartnerBank = [{
                BankIdentification: DEFAULT_BANK_ID,
                BankCountryKey: pick(b, FIELDS.bankCountry, 3).toUpperCase() || country,
                BankNumber: bankKey,
                BankAccount: account,
                BankAccountHolderName: pick(b, FIELDS.bankHolder, 60) || clip(d.name, 60),
                IBAN: pick(b, FIELDS.iban, 34)
            }];
        }

        // tax: only when category AND number are available
        const taxType = pick(t, FIELDS.taxType, 4);
        const taxNumber = pick(t, FIELDS.taxNumber, 20);
        if (taxType && taxNumber) {
            payload.to_BusinessPartnerTax = [{ BPTaxType: taxType, BPTaxNumber: taxNumber }];
        }

        // deep insert: BP + roles + address (+ bank, tax) in one call; empty values are dropped
        const bp = await create(model, "/A_BusinessPartner", compact(payload));
        bpNumber = bp.BusinessPartner as string;
    }

    // supplier is generated through the FLVN roles; add purchasing org data (skip if already there)
    // This step is optional: the supplier already exists at this point, so a failure here
    // (e.g. purchasing org not maintained in SAP) is logged and ignored.
    if (d.purchasingOrg) {
        try {
            const supplierPath = "/" + model.createKey("A_Supplier", { Supplier: bpNumber });
            const orgs = await read(model, `${supplierPath}/to_SupplierPurchasingOrg`,
                [new Filter("PurchasingOrganization", FilterOperator.EQ, clip(d.purchasingOrg, 4))]);
            if (!orgs.length) {
                await create(model, `${supplierPath}/to_SupplierPurchasingOrg`, {
                    PurchasingOrganization: clip(d.purchasingOrg, 4)
                });
            }
        } catch (e) {
            console.warn(`Purchasing organization ${d.purchasingOrg} could not be added to supplier ${bpNumber} - skipped.`, e);
        }
    }
    return {
        bpNumber,
        supplierNumber: bpNumber
    };
}

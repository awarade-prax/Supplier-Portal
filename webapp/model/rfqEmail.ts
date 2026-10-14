import ODataModel from "sap/ui/model/odata/v2/ODataModel";
import Filter from "sap/ui/model/Filter";
import FilterOperator from "sap/ui/model/FilterOperator";

interface RfqBidder {
    Supplier?: string;
}

interface SapCreation {
    SupplierNumber?: string;
    SupplierID?: string;
    SAP_PARENT_UUID?: string;
}

interface SupplierOnboarding {
    SAP_UUID?: string;
    ID?: string;
    SupplierEmail?: string;
    AccessToken?: string;
}

export interface RfqEmailRecipientResult {
    rfqNumber: string;
    supplierId: string;
    email?: string;
    sent: boolean;
    error?: string;
}

export interface RfqEmailProgress {
    rfqNumber: string;
    supplierId: string;
    supplierIndex: number;
    supplierCount: number;
}

export interface RfqEmailBatchResult {
    rfqNumber: string;
    recipients: RfqEmailRecipientResult[];
    error?: string;
}

function readCollection<T>(model: ODataModel, path: string, filters: Filter[]): Promise<T[]> {
    return new globalThis.Promise<T[]>((resolve, reject) => {
        model.read(path, {
            filters,
            success: (data: { results?: T[] }) => {
                if (!Array.isArray(data.results)) {
                    reject(new Error(`The service returned an invalid response for ${path}.`));
                    return;
                }
                resolve(data.results);
            },
            error: reject
        });
    });
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
        return error.message;
    }
    return "An unexpected error occurred.";
}

export async function sendRfqEmails(
    rfqModel: ODataModel,
    onboardingModel: ODataModel,
    rfqNumber: string,
    quotationDeadline: string,
    onProgress?: (progress: RfqEmailProgress) => void,
    onRecipientResult?: (result: RfqEmailRecipientResult) => void
): Promise<RfqEmailBatchResult> {
    const bidderRows = await readCollection<RfqBidder>(rfqModel, "/RFQ_Bidder", [
        new Filter("RequestForQuotation", FilterOperator.EQ, rfqNumber)
    ]);
    const supplierIds = Array.from(new Set(
        bidderRows.map((bidder) => bidder.Supplier?.trim()).filter((supplierId): supplierId is string => !!supplierId)
    ));
    const recipients: RfqEmailRecipientResult[] = [];

    for (const [index, supplierId] of supplierIds.entries()) {
        onProgress?.({
            rfqNumber,
            supplierId,
            supplierIndex: index + 1,
            supplierCount: supplierIds.length
        });

        let email: string | undefined;
        try {
            const sapCreations = await readCollection<SapCreation>(
                onboardingModel,
                "/YY1_SAPCREATION_SUPPLIER_ONBOA",
                [new Filter("SupplierNumber", FilterOperator.EQ, supplierId)]
            );
            const sapCreation = sapCreations.find((record) => record.SupplierNumber?.trim() === supplierId);
            if (!sapCreation?.SAP_PARENT_UUID || !sapCreation.SupplierID) {
                throw new Error("No matching SAP supplier record was found.");
            }

            const onboardings = await readCollection<SupplierOnboarding>(
                onboardingModel,
                "/YY1_SUPPLIER_ONBOARDING",
                [
                    new Filter("SAP_UUID", FilterOperator.EQ, sapCreation.SAP_PARENT_UUID),
                    new Filter("ID", FilterOperator.EQ, sapCreation.SupplierID)
                ]
            );
            const onboarding = onboardings.find((record) =>
                record.SAP_UUID === sapCreation.SAP_PARENT_UUID && record.ID === sapCreation.SupplierID
            );
            email = onboarding?.SupplierEmail?.trim();
            if (!email || !onboarding?.AccessToken?.trim()) {
                throw new Error("The supplier email or access token is missing from the onboarding record.");
            }

            const response = await fetch("/mail-api/send-rfq-invitation", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    toEmail: email,
                    accessToken: onboarding.AccessToken,
                    rfqNumber,
                    quotationDeadline
                })
            });
            if (!response.ok) {
                throw new Error(`Mail service responded with status ${response.status}.`);
            }
            const recipient = { rfqNumber, supplierId, email, sent: true };
            recipients.push(recipient);
            onRecipientResult?.(recipient);
        } catch (error: unknown) {
            const recipient = { rfqNumber, supplierId, email, sent: false, error: errorMessage(error) };
            recipients.push(recipient);
            onRecipientResult?.(recipient);
        }
    }

    return { rfqNumber, recipients };
}

export function getRfqEmailErrorMessage(error: unknown): string {
    return errorMessage(error);
}

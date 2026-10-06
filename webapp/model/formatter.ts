// Status code -> description (fallback when the service returns no Status_Text)
const STATUS_TEXT: Record<string, string> = {
    "1": "Submitted",
    "2": "Drafted by Supplier",
    "3": "Under Review of Purchase",
    "4": "Approved by Purchase",
    "5": "Rejected by Purchase",
    "6": "Sent Back by Purchase",
    "7": "Under Review of Finance",
    "8": "Approved by Finance",
    "9": "Rejected by Finance",
    "10": "Sent Back by Finance",
    "11": "Overall Approved"
};

export default {
    statusText(code: string | undefined, text: string | undefined): string {
        return text || STATUS_TEXT[code ?? ""] || STATUS_TEXT["1"];
    },
    // empty status is treated as "Submitted"
    statusCode(code: string | undefined): string {
        return code && STATUS_TEXT[code] ? code : "1";
    },
    pin(value: string | undefined): string {
        return String(value || "").replace(/^0+/, "");
    }
};
// Loads mail-srv/.env into process.env for local development.
// In Cloud Foundry there is no .env file, so this silently does nothing.
// Real configuration comes from the bound
// "supplierportal-smtp-credentials" user-provided service.
require("dotenv").config();

const express = require("express");
const nodemailer = require("nodemailer");
const passport = require("passport");

const app = express();

// Marker so you can tell which code is really running.
// Open http://localhost:4004/mail-api/health - it must show this value.
const MAIL_TEMPLATE_VERSION = "link-v2";

app.use(express.json());

// ---------------------------------------------------------------------
// Supplier Portal URL
// ---------------------------------------------------------------------
// This is the base URL of your deployed Supplier Portal application.
// The AccessToken will be added automatically to this URL.
//
// Example:
// https://your-app.cfapps.in30.hana.ondemand.com/?token=ABC123
// ---------------------------------------------------------------------
const PORTAL_BASE_URL = "https://praxis-info-solutions-pvt--ltd--dev-praxis-development-302e48aa.cfapps.in30.hana.ondemand.com";

// ---------------------------------------------------------------------
// XSUAA authentication
// (skipped gracefully when not bound, e.g. local development)
// ---------------------------------------------------------------------
let authMiddleware = (req, res, next) => next();

try {
    const xsenv = require("@sap/xsenv");
    const { JWTStrategy } = require("@sap/xssec");

    const services = xsenv.getServices({
        uaa: { tag: "xsuaa" }
    });

    passport.use(new JWTStrategy(services.uaa));

    app.use(passport.initialize());

    authMiddleware = passport.authenticate("JWT", {
        session: false
    });

    console.log("XSUAA authentication enabled.");

} catch (e) {

    console.warn(
        "XSUAA service not bound - running WITHOUT auth (local/dev mode only).",
        e.message
    );
}

// ---------------------------------------------------------------------
// SMTP credentials
// ---------------------------------------------------------------------
// Reads SMTP configuration from the bound
// "supplierportal-smtp-credentials" service in Cloud Foundry.
//
// Falls back to environment variables for local development.
// ---------------------------------------------------------------------
function getSmtpConfig() {

    try {

        const xsenv = require("@sap/xsenv");

        const services = xsenv.getServices({
            smtp: {
                tag: "supplierportal-smtp-credentials"
            }
        });

        return services.smtp;

    } catch (e) {

        return {
            SMTP_HOST: process.env.SMTP_HOST,
            SMTP_PORT: process.env.SMTP_PORT,
            SMTP_USER: process.env.SMTP_USER,
            SMTP_PASSWORD: process.env.SMTP_PASSWORD,
            SMTP_SENDER_NAME: process.env.SMTP_SENDER_NAME
        };
    }
}

// ---------------------------------------------------------------------
// SMTP transporter
// ---------------------------------------------------------------------
function getTransporter() {

    const cfg = getSmtpConfig();

    const port = Number(cfg.SMTP_PORT || 587);

    return nodemailer.createTransport({

        host: cfg.SMTP_HOST,

        port,

        secure: port === 465,

        requireTLS: port !== 465,

        tls: {
            minVersion: "TLSv1.2"
        },

        auth: {
            user: cfg.SMTP_USER,
            pass: cfg.SMTP_PASSWORD
        }
    });
}

// ---------------------------------------------------------------------
// Clean email/header values
// ---------------------------------------------------------------------
function cleanLine(value) {

    return (value || "")
        .replace(/[\r\n]/g, "")
        .trim();
}

// ---------------------------------------------------------------------
// Escape HTML values
// ---------------------------------------------------------------------
function escapeHtml(value) {

    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// ---------------------------------------------------------------------
// Send Supplier Onboarding Confirmation
// ---------------------------------------------------------------------
app.post(
    "/mail-api/send-confirmation",
    authMiddleware,
    async (req, res) => {

        const {
            toEmail,
            supplierName,
            supplierEmail,
            purchasingOrganization,
            supplierCategory,
            accessToken
        } = req.body || {};

        // -------------------------------------------------------------
        // Validate email
        // -------------------------------------------------------------

        if (!toEmail) {

            return res.status(400).json({
                status: "error",
                message: "toEmail is required"
            });
        }

        // -------------------------------------------------------------
        // Validate AccessToken
        // -------------------------------------------------------------

        if (!accessToken) {

            return res.status(400).json({
                status: "error",
                message: "accessToken is required"
            });
        }

        // -------------------------------------------------------------
        // Create supplier-specific onboarding URL
        // -------------------------------------------------------------

        const portalUrl =
            `${PORTAL_BASE_URL}/?token=${encodeURIComponent(accessToken)}`;

        console.log(
            "Supplier portal URL generated successfully (" +
            MAIL_TEMPLATE_VERSION + ")."
        );

        // -------------------------------------------------------------
        // SMTP configuration
        // -------------------------------------------------------------

        const cfg = getSmtpConfig();

        const senderName =
            cleanLine(cfg.SMTP_SENDER_NAME) || "Supplier Portal";

        const senderUser = cfg.SMTP_USER;

        // -------------------------------------------------------------
        // Email subject
        // -------------------------------------------------------------

        const subject = cleanLine(
            `Supplier Onboarding Request Received - ${supplierName || ""}`
        );

        // -------------------------------------------------------------
        // Escape values used inside HTML
        // -------------------------------------------------------------

        const safeSupplierName =
            escapeHtml(supplierName || "Supplier");

        const safeSupplierEmail =
            escapeHtml(supplierEmail || "-");

        const safePurchasingOrganization =
            escapeHtml(purchasingOrganization || "-");

        const safeSupplierCategory =
            escapeHtml(supplierCategory || "-");

        const safeSenderName =
            escapeHtml(senderName);

        // -------------------------------------------------------------
        // Email body
        // -------------------------------------------------------------

        const body = `
            <div style="
                font-family: Arial, sans-serif;
                font-size: 14px;
                color: #333333;
            ">

                <p>
                    Dear ${safeSupplierName},
                </p>

                <p>
                    Thank you for submitting a supplier onboarding request.
                </p>

                <p>
                    Please click the button below to complete
                    your supplier onboarding details.
                </p>

                <p style="margin: 25px 0;">

                    <a
                        href="${portalUrl}"
                        style="
                            background-color: #0a6ed1;
                            color: #ffffff;
                            padding: 12px 24px;
                            text-decoration: none;
                            border-radius: 4px;
                            display: inline-block;
                            font-weight: bold;
                        "
                    >
                        Open Supplier Onboarding
                    </a>

                </p>

                <p>
                    <b>Supplier Name:</b>
                    ${safeSupplierName}
                </p>

                <p>
                    <b>Supplier Email:</b>
                    ${safeSupplierEmail}
                </p>

                <p>
                    <b>Purchasing Organization:</b>
                    ${safePurchasingOrganization}
                </p>

                <p>
                    <b>Supplier Category:</b>
                    ${safeSupplierCategory}
                </p>

                <p>
                    Our team will review your request and get back to
                    you shortly.
                </p>

                <br><br>

                <p>
                    Regards,<br>
                    ${safeSenderName}
                </p>

            </div>
        `;

        // -------------------------------------------------------------
        // Send email
        // -------------------------------------------------------------

        try {

            const transporter = getTransporter();

            await transporter.sendMail({

                from: `"${senderName}" <${senderUser}>`,

                to: cleanLine(toEmail),

                subject: subject,

                html: body
            });

            return res.status(200).json({

                status: "success",

                message: "Mail sent successfully"

            });

        } catch (err) {

            console.error(
                "SMTP send failed:",
                err
            );

            return res.status(500).json({

                status: "error",

                message:
                    (err && err.message) ||
                    "Mail send failed"

            });
        }
    }
);

// ---------------------------------------------------------------------
// Send RFQ invitation to a registered supplier
// ---------------------------------------------------------------------
app.post(
    "/mail-api/send-rfq-invitation",
    authMiddleware,
    async (req, res) => {

        const {
            toEmail,
            accessToken,
            rfqNumber,
            quotationDeadline,
            supplierName
        } = req.body || {};

        if (typeof toEmail !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toEmail.trim())) {
            return res.status(400).json({
                status: "error",
                message: "A valid toEmail is required"
            });
        }

        if (typeof accessToken !== "string" || !accessToken.trim()) {
            return res.status(400).json({
                status: "error",
                message: "accessToken is required"
            });
        }

        if (typeof rfqNumber !== "string" || !rfqNumber.trim()) {
            return res.status(400).json({
                status: "error",
                message: "rfqNumber is required"
            });
        }

        const cfg = getSmtpConfig();
        const senderName = cleanLine(cfg.SMTP_SENDER_NAME) || "Supplier Portal";
        const senderUser = cfg.SMTP_USER;
        const safeRfqNumber = escapeHtml(rfqNumber);
        const safeSupplierName = escapeHtml(supplierName || "Supplier");
        const safeQuotationDeadline = escapeHtml(quotationDeadline || "the stated deadline");
        const portalUrl = `${PORTAL_BASE_URL}/?token=${encodeURIComponent(accessToken.trim())}`;
        const subject = `Submit Your Quotation for RFQ - ${cleanLine(rfqNumber)}`;
        const body = `
            <div style="font-family: Arial, sans-serif; font-size: 14px; color: #333333;">
                <p>Dear ${safeSupplierName},</p>
                <p>Please find attached our Request for Quotation <b>${safeRfqNumber}</b> for the listed materials/services.</p>
                <p>Kindly submit your quotation with the following details against each item:</p>
                <ul>
                    <li>Unit price and currency</li>
                    <li>Delivery date or lead time</li>
                    <li>Payment terms</li>
                    <li>Quotation validity</li>
                    <li>Technical specifications and any deviations from our requirements</li>
                </ul>
                <p>Please submit your response by <b>${safeQuotationDeadline}</b>.</p>
                <p style="margin: 25px 0;">
                    <a href="${portalUrl}" style="background-color: #0a6ed1; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 4px; display: inline-block; font-weight: bold;">
                        Open Supplier Portal
                    </a>
                </p>
                <p>For any clarification, please contact "Purchase Department" at
                    <a href="mailto:purchase@praxisinfosolutions.com">purchase@praxisinfosolutions.com</a>.
                </p>
                <p>We look forward to receiving your quotation.</p>
                <p>Best regards,<br>Praxis Info Solutions Pvt. Ltd.</p>
            </div>
        `;

        try {
            const transporter = getTransporter();
            await transporter.sendMail({
                from: `"${senderName}" <${senderUser}>`,
                to: cleanLine(toEmail),
                subject,
                html: body
            });

            return res.status(200).json({
                status: "success",
                message: "RFQ invitation sent successfully"
            });
        } catch (err) {
            console.error("SMTP send failed:", err);
            return res.status(500).json({
                status: "error",
                message: (err && err.message) || "Mail send failed"
            });
        }
    }
);

// ---------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------
app.get(
    "/mail-api/health",
    (req, res) => {

        res.status(200).send("ok " + MAIL_TEMPLATE_VERSION);
    }
);

// ---------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------
const port = process.env.PORT || 4004;

const server = app.listen(port, () => {

    console.log(
        `mail-srv ${MAIL_TEMPLATE_VERSION} listening on port ${port}`
    );

    console.log(
        `Supplier Portal Base URL: ${PORTAL_BASE_URL}`
    );

    // Diagnostic only - never log the actual password.
    const cfg = getSmtpConfig();

    console.log(
        "Loaded SMTP config:",
        {
            SMTP_HOST:
                cfg.SMTP_HOST || "(missing)",

            SMTP_PORT:
                cfg.SMTP_PORT || "(missing)",

            SMTP_USER:
                cfg.SMTP_USER || "(missing)",

            SMTP_PASSWORD:
                cfg.SMTP_PASSWORD
                    ? "***set***"
                    : "(missing)",

            SMTP_SENDER_NAME:
                cfg.SMTP_SENDER_NAME || "(missing)"
        }
    );

    if (
        cfg.SMTP_HOST === "smtp.yourdomain.com" ||
        !cfg.SMTP_HOST
    ) {

        console.warn(
            "WARNING: SMTP_HOST still looks like the placeholder value. " +
            "Real emails will fail to send until .env has real credentials."
        );
    }
});

server.on("error", (err) => {

    if (err && err.code === "EADDRINUSE") {

        console.error(
            `PORT ${port} IS ALREADY IN USE - an OLD mail-srv is still ` +
            "running and will keep sending the old email. " +
            `Stop it first (fuser -k ${port}/tcp) and start again.`
        );

    } else {

        console.error("mail-srv failed to start:", err);
    }

    process.exit(1);
});
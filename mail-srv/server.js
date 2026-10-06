// Loads mail-srv/.env into process.env for local development.
// In Cloud Foundry there is no .env file, so this silently does nothing
// and real config comes from the bound "supplierportal-smtp-credentials"
// user-provided service instead (see getSmtpConfig() below).
require("dotenv").config();

const express = require("express");
const nodemailer = require("nodemailer");
const passport = require("passport");

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------
// XSUAA authentication (skipped gracefully when not bound, e.g. local dev)
// ---------------------------------------------------------------------
let authMiddleware = (req, res, next) => next();
try {
    const xsenv = require("@sap/xsenv");
    const { JWTStrategy } = require("@sap/xssec");
    const services = xsenv.getServices({ uaa: { tag: "xsuaa" } });
    passport.use(new JWTStrategy(services.uaa));
    app.use(passport.initialize());
    authMiddleware = passport.authenticate("JWT", { session: false });
    console.log("XSUAA authentication enabled.");
} catch (e) {
    console.warn("XSUAA service not bound - running WITHOUT auth (local/dev mode only).", e.message);
}

// ---------------------------------------------------------------------
// SMTP credentials: read from a bound user-provided service
// ("supplierportal-smtp-credentials") in Cloud Foundry, falling back
// to plain env vars for local development.
// ---------------------------------------------------------------------
function getSmtpConfig() {
    try {
        const xsenv = require("@sap/xsenv");
        const services = xsenv.getServices({
            smtp: { tag: "supplierportal-smtp-credentials" }
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

function getTransporter() {
    const cfg = getSmtpConfig();
    const port = Number(cfg.SMTP_PORT || 587);

    return nodemailer.createTransport({
        host: cfg.SMTP_HOST,
        port,
        secure: port === 465,      // true for 465 (implicit TLS), false for STARTTLS ports (e.g. 587)
        requireTLS: port !== 465,  // mirrors ServicePointManager.SecurityProtocol Tls/Tls11/Tls12 + EnableSsl in the .NET reference
        tls: {
            minVersion: "TLSv1.2"
        },
        auth: {
            user: cfg.SMTP_USER,
            pass: cfg.SMTP_PASSWORD
        }
    });
}

// Mirrors the .NET code's .Replace("\n", "").Replace("\r", "") address/subject cleanup
function cleanLine(value) {
    return (value || "").replace(/[\r\n]/g, "").trim();
}

app.post("/mail-api/send-confirmation", authMiddleware, async (req, res) => {
    const {
        toEmail,
        supplierName,
        supplierEmail,
        purchasingOrganization,
        supplierCategory
    } = req.body || {};

    if (!toEmail) {
        return res.status(400).json({ status: "error", message: "toEmail is required" });
    }

    const cfg = getSmtpConfig();
    const senderName = cleanLine(cfg.SMTP_SENDER_NAME) || "Supplier Portal";
    const senderUser = cfg.SMTP_USER;

    const subject = cleanLine(`Supplier Onboarding Request Received - ${supplierName || ""}`);

    const body = `
        <p>Dear ${supplierName || "Supplier"},</p>
        <p>Thank you for submitting a supplier onboarding request. Here is a summary of what was received:</p>
        <ul>
            <li><b>Supplier Name:</b> ${supplierName || "-"}</li>
            <li><b>Supplier Email:</b> ${supplierEmail || "-"}</li>
            <li><b>Purchasing Organization:</b> ${purchasingOrganization || "-"}</li>
            <li><b>Supplier Category:</b> ${supplierCategory || "-"}</li>
        </ul>
        <p>Our team will review your request and get back to you shortly.</p>
        <br><br><br>
        <p>Regards,<br>${senderName}</p>
    `;

    try {
        const transporter = getTransporter();
        await transporter.sendMail({
            from: `"${senderName}" <${senderUser}>`,
            to: cleanLine(toEmail),
            subject,
            html: body
        });

        return res.status(200).json({ status: "success", message: "Mail sent successfully" });
    } catch (err) {
        console.error("SMTP send failed:", err);
        return res.status(500).json({
            status: "error",
            message: (err && err.message) || "Mail send failed"
        });
    }
});

app.get("/mail-api/health", (req, res) => res.status(200).send("ok"));

const port = process.env.PORT || 4004;
app.listen(port, () => {
    console.log(`mail-srv listening on port ${port}`);

    // Diagnostic only - never logs the actual password.
    const cfg = getSmtpConfig();
    console.log("Loaded SMTP config:", {
        SMTP_HOST: cfg.SMTP_HOST || "(missing)",
        SMTP_PORT: cfg.SMTP_PORT || "(missing)",
        SMTP_USER: cfg.SMTP_USER || "(missing)",
        SMTP_PASSWORD: cfg.SMTP_PASSWORD ? "***set***" : "(missing)",
        SMTP_SENDER_NAME: cfg.SMTP_SENDER_NAME || "(missing)"
    });
    if (cfg.SMTP_HOST === "smtp.yourdomain.com" || !cfg.SMTP_HOST) {
        console.warn("WARNING: SMTP_HOST still looks like the placeholder value. Real emails will fail to send until .env has real credentials.");
    }
});
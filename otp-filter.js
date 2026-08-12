"use strict";

/**
 * Single-file OTP filter with SQLite cache + optional OpenAI fallback.
 *
 * Dependency:
 *   - Node 22.5+ / 24+ can use built-in node:sqlite.
 *   - For older Node versions, install fallback dependency: npm i sqlite3
 *
 * Env:
 *   OPENAI_API_KEY=sk-...
 *   OPENAI_MODEL=gpt-4.1-mini   optional
 *   OTP_AI_ENABLED=true|false optional, default: true
 *
 * Usage:
 *   const { createOtpFilter } = require("./otp-filter");
 *   const otpFilter = createOtpFilter({ dbPath: "./otp-cache.sqlite" });
 *   const result = await otpFilter.filterEmail(emailObject);
 *   const resultFromUrl = await otpFilter.filterUrl("https://prod.pusat.email/api/v1/messages/id");
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

let DatabaseSync;
const originalEmitWarning = process.emitWarning;
try {
  process.emitWarning = function patchedEmitWarning(warning, ...args) {
    const warningName = typeof args[0] === "string" ? args[0] : args[0] && args[0].type;
    if (warningName === "ExperimentalWarning" && String(warning).includes("SQLite")) return;
    return originalEmitWarning.call(this, warning, ...args);
  };
  ({ DatabaseSync } = require("node:sqlite"));
} catch (error) {
  DatabaseSync = null;
} finally {
  process.emitWarning = originalEmitWarning;
}

loadDotEnv();

const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const OTP_HINT_RE =
  /\b(otp|kode|code|verification|verifikasi|verify|login|masuk|sign\s*in|daftar|register|pendaftaran|auth|authentication|security|keamanan|2fa|mfa|pin)\b/i;

const AUTH_LINK_HINT_RE =
  /\b(link|tautan|tap|klik|click|create your account|buat akun|magic link|passwordless|no password|securely sign in|expire|expires?|expired|kedaluwarsa|verification link|confirm|konfirmasi)\b/i;

const NEGATIVE_HINT_RE =
  /\b(newsletter|promo|promotion|marketing|invoice|receipt|tagihan|struk|newsletter|unsubscribe|berhenti berlangganan)\b/i;

const AI_ENABLED = parseEnvBoolean(
  process.env.OTP_AI_ENABLED ?? process.env.OTP_AI_MODE ?? process.env.AI_MODE,
  true,
);

function createOtpFilter(options = {}) {
  const filter = new OtpFilter(options);

  return {
    filterEmail: (email) => filter.filterEmail(email),
    filterUrl: (url, fetchOptions) => filter.filterUrl(url, fetchOptions),
    close: () => filter.close(),
  };
}

class OtpFilter {
  constructor(options = {}) {
    this.dbPath = options.dbPath || "./otp-cache.sqlite";
    this.openaiApiKey = options.openaiApiKey || process.env.OPENAI_API_KEY || "";
    this.model = options.model || DEFAULT_MODEL;
    this.aiEnabled =
      options.aiEnabled !== undefined
        ? Boolean(options.aiEnabled)
        : AI_ENABLED;
    this.debug = Boolean(options.debug || process.env.OTP_FILTER_DEBUG === "1");
    this.logger = typeof options.logger === "function" ? options.logger : console.log;
    this.maxNonOtpTemplates = Number(options.maxNonOtpTemplates || 1000);
    this.storeMessages = Boolean(options.storeMessages || process.env.OTP_STORE_MESSAGES === "1");
    this.db = openSqliteDatabase(this.dbPath);
    this.ready = this.init();
  }

  async init() {
    await this.run(`
      CREATE TABLE IF NOT EXISTS otp_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        template_key TEXT NOT NULL UNIQUE,
        from_address TEXT,
        sender_domain TEXT,
        subject_mask TEXT,
        body_hash TEXT NOT NULL,
        service TEXT,
        confidence REAL NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'local',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    await this.run(`
      CREATE TABLE IF NOT EXISTS otp_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email_id TEXT,
        template_key TEXT,
        from_address TEXT,
        to_address TEXT,
        subject TEXT,
        service TEXT,
        otp_code TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        raw_created_at INTEGER
      )
    `);

    await this.run(`
      CREATE TABLE IF NOT EXISTS non_otp_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        template_key TEXT NOT NULL UNIQUE,
        from_address TEXT,
        sender_domain TEXT,
        subject_mask TEXT,
        body_hash TEXT NOT NULL,
        service TEXT,
        reason TEXT,
        confidence REAL NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'openai',
        hit_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    await this.run(`
      CREATE TABLE IF NOT EXISTS auth_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        template_key TEXT NOT NULL UNIQUE,
        artifact_type TEXT NOT NULL,
        from_address TEXT,
        sender_domain TEXT,
        subject_mask TEXT,
        body_hash TEXT NOT NULL,
        service TEXT,
        confidence REAL NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'local',
        hit_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    await this.run(`
      CREATE TABLE IF NOT EXISTS auth_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email_id TEXT,
        template_key TEXT,
        artifact_type TEXT NOT NULL,
        from_address TEXT,
        to_address TEXT,
        subject TEXT,
        service TEXT,
        code TEXT,
        url TEXT,
        confidence REAL NOT NULL DEFAULT 0,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        raw_created_at INTEGER
      )
    `);

    await this.run(`
      CREATE TABLE IF NOT EXISTS auth_extract_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        template_key TEXT NOT NULL,
        sender_domain TEXT,
        subject_mask TEXT,
        artifact_type TEXT NOT NULL,
        field TEXT NOT NULL,
        before_text TEXT NOT NULL,
        after_text TEXT NOT NULL,
        regex_pattern TEXT,
        code_style TEXT,
        url_param TEXT,
        confidence REAL NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'openai',
        hit_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(template_key, artifact_type, field, before_text, after_text)
      )
    `);

    await this.migrateOptionalColumns();

    await this.run("CREATE INDEX IF NOT EXISTS idx_otp_messages_email_id ON otp_messages(email_id)");
    await this.run("CREATE INDEX IF NOT EXISTS idx_otp_templates_key ON otp_templates(template_key)");
    await this.run("CREATE INDEX IF NOT EXISTS idx_non_otp_templates_key ON non_otp_templates(template_key)");
    await this.run("CREATE INDEX IF NOT EXISTS idx_auth_templates_key ON auth_templates(template_key)");
    await this.run("CREATE INDEX IF NOT EXISTS idx_auth_messages_email_id ON auth_messages(email_id)");
    await this.run("CREATE INDEX IF NOT EXISTS idx_auth_extract_rules_key ON auth_extract_rules(template_key)");
    await this.run("CREATE INDEX IF NOT EXISTS idx_auth_extract_rules_fallback ON auth_extract_rules(sender_domain, subject_mask)");
  }

  async migrateOptionalColumns() {
    const migrations = [
      "ALTER TABLE auth_extract_rules ADD COLUMN sender_domain TEXT",
      "ALTER TABLE auth_extract_rules ADD COLUMN subject_mask TEXT",
      "ALTER TABLE auth_extract_rules ADD COLUMN regex_pattern TEXT",
    ];

    for (const sql of migrations) {
      try {
        await this.run(sql);
      } catch (error) {
        if (!String(error && error.message).includes("duplicate column")) throw error;
      }
    }
  }

  async filterEmail(email) {
    await this.ready;

    const normalized = normalizeEmail(email);
    const hint = hasOtpHint(normalized);
    const local = extractOtpLocally(normalized);
    const localLink = extractAuthLinkLocally(normalized);
    const localArtifact = local.code
      ? { type: "otp", code: local.code, url: null, confidence: local.confidence }
      : localLink.url
        ? { type: "link", code: localLink.code, url: localLink.url, confidence: localLink.confidence }
        : null;
    this.log(
      `scan from="${normalized.from}" subject="${normalized.subject}" hint=${hint} localOtp=${local.code || "-"} localLink=${localLink.url ? "yes" : "-"}`,
    );

    if (!hint && !localArtifact) {
      this.log("skip openai: email tidak punya indikasi OTP/auth link");
      return {
        isOtp: false,
        otp: null,
        type: null,
        code: null,
        url: null,
        service: normalized.service,
        source: "skip",
        reason: "Tidak ada indikasi OTP/auth link dari subject/from/body.",
      };
    }

    const templateKey = createTemplateKey(normalized);
    const cachedAuthTemplate = await this.get(
      "SELECT * FROM auth_templates WHERE template_key = ? LIMIT 1",
      [templateKey],
    );

    if (cachedAuthTemplate && localArtifact && cachedAuthTemplate.artifact_type === localArtifact.type) {
      this.log(`skip openai: pakai cache auth ${localArtifact.type}`);
      await this.touchAuthTemplate(templateKey);
      await this.saveAuthMessage({
        email: normalized,
        templateKey,
        artifact: localArtifact,
        service: cachedAuthTemplate.service || normalized.service,
        confidence: Math.max(localArtifact.confidence, cachedAuthTemplate.confidence || 0.8),
        source: "auth-cache+local",
      });

      if (localArtifact.type === "otp") {
        await this.saveOtpMessage({
          email: normalized,
          templateKey,
          code: localArtifact.code,
          service: cachedAuthTemplate.service || normalized.service,
          confidence: Math.max(localArtifact.confidence, cachedAuthTemplate.confidence || 0.8),
          source: "auth-cache+local",
        });
      }

      return buildAuthResult({
        artifact: localArtifact,
        service: cachedAuthTemplate.service || normalized.service,
        source: "auth-cache+local",
        templateKey,
        confidence: Math.max(localArtifact.confidence, cachedAuthTemplate.confidence || 0.8),
      });
    }

    if (cachedAuthTemplate && !localArtifact) {
      const learnedArtifact = await this.extractWithLearnedRules(normalized, templateKey, cachedAuthTemplate.artifact_type);
      if (learnedArtifact) {
        this.log(`skip openai: pakai learned split rule ${learnedArtifact.type}`);
        await this.touchAuthTemplate(templateKey);
        await this.saveAuthMessage({
          email: normalized,
          templateKey,
          artifact: learnedArtifact,
          service: cachedAuthTemplate.service || normalized.service,
          confidence: Math.max(learnedArtifact.confidence, cachedAuthTemplate.confidence || 0.8),
          source: "learned-rule",
        });

        if (learnedArtifact.type === "otp") {
          await this.saveOtpMessage({
            email: normalized,
            templateKey,
            code: learnedArtifact.code,
            service: cachedAuthTemplate.service || normalized.service,
            confidence: Math.max(learnedArtifact.confidence, cachedAuthTemplate.confidence || 0.8),
            source: "learned-rule",
          });
        }

        return buildAuthResult({
          artifact: learnedArtifact,
          service: cachedAuthTemplate.service || normalized.service,
          source: "learned-rule",
          templateKey,
          confidence: Math.max(learnedArtifact.confidence, cachedAuthTemplate.confidence || 0.8),
        });
      }
    }

    if (!localArtifact) {
      const learnedArtifact = await this.extractWithLearnedRules(normalized, templateKey, null);
      if (learnedArtifact) {
        this.log(`skip openai: pakai learned fallback rule ${learnedArtifact.type}`);
        await this.saveAuthTemplate({
          email: normalized,
          templateKey,
          artifactType: learnedArtifact.type,
          service: normalized.service,
          confidence: learnedArtifact.confidence,
          source: "learned-rule",
        });
        await this.saveAuthMessage({
          email: normalized,
          templateKey,
          artifact: learnedArtifact,
          service: normalized.service,
          confidence: learnedArtifact.confidence,
          source: "learned-rule",
        });

        if (learnedArtifact.type === "otp") {
          await this.saveOtpMessage({
            email: normalized,
            templateKey,
            code: learnedArtifact.code,
            service: normalized.service,
            confidence: learnedArtifact.confidence,
            source: "learned-rule",
          });
        }

        return buildAuthResult({
          artifact: learnedArtifact,
          service: normalized.service,
          source: "learned-rule",
          templateKey,
          confidence: learnedArtifact.confidence,
        });
      }
    }

    const cachedTemplate = await this.get(
      "SELECT * FROM otp_templates WHERE template_key = ? LIMIT 1",
      [templateKey],
    );

    if (cachedTemplate && local.code) {
      this.log(`skip openai: pakai cache template + local extractor otp=${local.code}`);
      await this.saveOtpMessage({
        email: normalized,
        templateKey,
        code: local.code,
        service: cachedTemplate.service || normalized.service,
        confidence: Math.max(local.confidence, cachedTemplate.confidence || 0.8),
        source: "cache+local",
      });

      return {
        isOtp: true,
        otp: local.code,
        service: cachedTemplate.service || normalized.service,
        source: "cache+local",
        templateKey,
        confidence: Math.max(local.confidence, cachedTemplate.confidence || 0.8),
      };
    }

    if (local.code && local.confidence >= 0.86) {
      this.log(`skip openai: local extractor confidence tinggi otp=${local.code}`);
      await this.saveAuthTemplate({
        email: normalized,
        templateKey,
        artifactType: "otp",
        service: normalized.service,
        confidence: local.confidence,
        source: "local",
      });
      await this.saveTemplate({
        email: normalized,
        templateKey,
        service: normalized.service,
        confidence: local.confidence,
        source: "local",
      });
      await this.saveOtpMessage({
        email: normalized,
        templateKey,
        code: local.code,
        service: normalized.service,
        confidence: local.confidence,
        source: "local",
      });

      return {
        isOtp: true,
        otp: local.code,
        service: normalized.service,
        source: "local",
        templateKey,
        confidence: local.confidence,
      };
    }

    if (localLink.url && localLink.confidence >= 0.86) {
      this.log(`skip openai: local extractor menemukan auth link code=${localLink.code || "-"}`);
      const artifact = {
        type: "link",
        code: localLink.code,
        url: localLink.url,
        confidence: localLink.confidence,
      };

      await this.saveAuthTemplate({
        email: normalized,
        templateKey,
        artifactType: "link",
        service: normalized.service,
        confidence: localLink.confidence,
        source: "local",
      });
      await this.saveAuthMessage({
        email: normalized,
        templateKey,
        artifact,
        service: normalized.service,
        confidence: localLink.confidence,
        source: "local",
      });

      return buildAuthResult({
        artifact,
        service: normalized.service,
        source: "local",
        templateKey,
        confidence: localLink.confidence,
      });
    }

    const cachedNonOtp = await this.get(
      "SELECT * FROM non_otp_templates WHERE template_key = ? LIMIT 1",
      [templateKey],
    );

    if (cachedNonOtp) {
      this.log("skip openai: pakai cache non-OTP");
      await this.touchNonOtpTemplate(templateKey);

      return {
        isOtp: false,
        otp: null,
        service: cachedNonOtp.service || normalized.service,
        source: "non-otp-cache",
        reason: cachedNonOtp.reason || "Template ini sebelumnya dinilai bukan OTP.",
        templateKey,
        confidence: cachedNonOtp.confidence || 0,
      };
    }

    if (!this.openaiApiKey) {
      this.log("skip openai: OPENAI_API_KEY belum diset");
      return {
        isOtp: Boolean(local.code),
        otp: local.code || null,
        type: localArtifact ? localArtifact.type : null,
        code: localArtifact ? localArtifact.code : null,
        url: localArtifact ? localArtifact.url : null,
        service: normalized.service,
        source: localArtifact ? "local-low-confidence" : "no-openai-key",
        reason: local.code
          ? "OTP ditemukan, tapi confidence rendah dan OPENAI_API_KEY belum diset."
          : "Email terlihat seperti auth message, tapi artifact tidak ketemu dan OPENAI_API_KEY belum diset.",
        confidence: localArtifact ? localArtifact.confidence : 0,
      };
    }

    if (!this.aiEnabled) {
      this.log("skip openai: OTP_AI_ENABLED=false");
      return {
        isOtp: Boolean(local.code),
        isAuth: Boolean(localArtifact),
        otp: local.code || null,
        type: localArtifact ? localArtifact.type : null,
        code: localArtifact ? localArtifact.code : null,
        url: localArtifact ? localArtifact.url : null,
        service: normalized.service,
        source: localArtifact ? "local-low-confidence" : "ai-off",
        reason: localArtifact
          ? "Artifact ditemukan, tapi confidence rendah dan AI dimatikan."
          : "Butuh OpenAI untuk klasifikasi/training, tapi OTP_AI_ENABLED=false.",
        confidence: localArtifact ? localArtifact.confidence : 0,
      };
    }

    this.log(`pakai openai: format auth artifact ambigu atau belum ada cache, model=${this.model}`);
    const ai = await this.askOpenAI(normalized, {
      otp: local,
      link: localLink,
    });

    if (!ai.isAuth || !["otp", "link"].includes(ai.type) || (!ai.otp && !ai.url && !ai.code)) {
      this.log("openai result: bukan auth artifact");
      await this.saveNonOtpTemplate({
        email: normalized,
        templateKey,
        service: ai.service || normalized.service,
        reason: ai.reason || "OpenAI menilai email ini bukan OTP/auth link.",
        confidence: ai.confidence || 0,
        source: "openai",
      });

      return {
        isOtp: false,
        otp: null,
        type: null,
        code: null,
        url: null,
        service: ai.service || normalized.service,
        source: "openai",
        reason: ai.reason || "OpenAI menilai email ini bukan OTP/auth link.",
        confidence: ai.confidence || 0,
      };
    }

    const artifact = {
      type: ai.type,
      code: ai.type === "otp" ? ai.otp || ai.code : ai.code || null,
      url: ai.type === "link" ? ai.url : null,
      confidence: ai.confidence || 0.75,
    };

    this.log(
      `openai result: type=${artifact.type} code=${artifact.code || "-"} url=${artifact.url ? "yes" : "-"} confidence=${artifact.confidence}`,
    );
    await this.saveAuthTemplate({
      email: normalized,
      templateKey,
      artifactType: artifact.type,
      service: ai.service || normalized.service,
      confidence: ai.confidence || 0.75,
      source: "openai",
    });
    await this.saveLearnedExtractRules({
      email: normalized,
      templateKey,
      artifact,
      extractor: ai.extractor || null,
      confidence: ai.confidence || 0.75,
      source: "openai",
    });
    await this.saveAuthMessage({
      email: normalized,
      templateKey,
      artifact,
      service: ai.service || normalized.service,
      confidence: ai.confidence || 0.75,
      source: "openai",
    });

    if (artifact.type === "otp") {
      await this.saveTemplate({
        email: normalized,
        templateKey,
        service: ai.service || normalized.service,
        confidence: ai.confidence || 0.75,
        source: "openai",
      });
      await this.saveOtpMessage({
        email: normalized,
        templateKey,
        code: artifact.code,
        service: ai.service || normalized.service,
        confidence: ai.confidence || 0.75,
        source: "openai",
      });
    }

    return buildAuthResult({
      artifact,
      service: ai.service || normalized.service,
      source: "openai",
      templateKey,
      confidence: ai.confidence || 0.75,
    });
  }

  async filterUrl(url, fetchOptions = {}) {
    const email = await fetchEmailMessage(url, fetchOptions);
    return this.filterEmail(email);
  }

  async askOpenAI(email, local) {
    const payload = {
      from: email.from,
      subject: email.subject,
      text: email.compactText.slice(0, 6000),
      localOtpCandidate: local.otp && local.otp.code ? local.otp.code : null,
      localLinkCandidate: local.link && local.link.url ? local.link.url : null,
    };

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        input: [
          {
            role: "system",
            content:
              "Anda adalah filter auth email sekaligus trainer extractor. Jawab hanya JSON valid tanpa markdown. Ambil hanya artifact untuk login/verifikasi/registrasi: OTP atau auth/magic/signup link. Jangan ambil nomor alamat, tahun, harga, invoice, tracking, privacy link, help link, unsubscribe link, atau marketing biasa. Jika menemukan artifact, isi extractor agar email serupa berikutnya bisa diproses tanpa AI.",
          },
          {
            role: "user",
            content:
              "Analisis email ini. Format JSON: {\"isAuth\":boolean,\"type\":\"otp\"|\"link\"|null,\"otp\":string|null,\"code\":string|null,\"url\":string|null,\"service\":string|null,\"confidence\":number,\"reason\":string,\"extractor\":{\"field\":\"subject\"|\"text\"|\"htmlText\"|\"compactText\"|null,\"before_text\":string|null,\"after_text\":string|null,\"regex_pattern\":string|null}}. OTP biasanya 4-10 digit/alfanumerik pendek. Link valid biasanya tombol/tautan utama untuk create account, sign in, verify, confirm, atau reset, sering memiliki query code/token dan masa berlaku. Untuk extractor, pilih field paling stabil dan buat regex dengan satu capture group untuk kode/link jika memungkinkan.\n\n" +
              JSON.stringify(payload),
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "auth_filter",
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                isAuth: { type: "boolean" },
                type: { type: ["string", "null"], enum: ["otp", "link", null] },
                otp: { type: ["string", "null"] },
                code: { type: ["string", "null"] },
                url: { type: ["string", "null"] },
                service: { type: ["string", "null"] },
                confidence: { type: "number" },
                reason: { type: "string" },
                extractor: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    field: {
                      type: ["string", "null"],
                      enum: ["subject", "text", "htmlText", "compactText", null],
                    },
                    before_text: { type: ["string", "null"] },
                    after_text: { type: ["string", "null"] },
                    regex_pattern: { type: ["string", "null"] },
                  },
                  required: ["field", "before_text", "after_text", "regex_pattern"],
                },
              },
              required: [
                "isAuth",
                "type",
                "otp",
                "code",
                "url",
                "service",
                "confidence",
                "reason",
                "extractor",
              ],
            },
          },
        },
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`OpenAI API error ${response.status}: ${detail}`);
    }

    const data = await response.json();
    const outputText = collectResponseText(data);
    const parsed = JSON.parse(outputText);

    if (parsed.otp) {
      parsed.otp = String(parsed.otp).replace(/[^\dA-Za-z-]/g, "");
    }
    if (parsed.code) {
      parsed.code = String(parsed.code).replace(/[^\dA-Za-z_-]/g, "");
    }

    return parsed;
  }

  saveTemplate({ email, templateKey, service, confidence, source }) {
    const now = Date.now();

    return this.run(
      `
      INSERT INTO otp_templates (
        template_key, from_address, sender_domain, subject_mask, body_hash,
        service, confidence, source, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(template_key) DO UPDATE SET
        service = excluded.service,
        confidence = excluded.confidence,
        source = excluded.source,
        updated_at = excluded.updated_at
      `,
      [
        templateKey,
        email.from,
        email.senderDomain,
        email.subjectMask,
        email.bodyHash,
        service,
        confidence,
        source,
        now,
        now,
      ],
    );
  }

  saveAuthTemplate({ email, templateKey, artifactType, service, confidence, source }) {
    const now = Date.now();

    return this.run(
      `
      INSERT INTO auth_templates (
        template_key, artifact_type, from_address, sender_domain, subject_mask, body_hash,
        service, confidence, source, hit_count, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT(template_key) DO UPDATE SET
        artifact_type = excluded.artifact_type,
        service = excluded.service,
        confidence = excluded.confidence,
        source = excluded.source,
        updated_at = excluded.updated_at
      `,
      [
        templateKey,
        artifactType,
        email.from,
        email.senderDomain,
        email.subjectMask,
        email.bodyHash,
        service,
        confidence,
        source,
        now,
        now,
      ],
    );
  }

  saveAuthMessage({ email, templateKey, artifact, service, confidence, source }) {
    if (!this.storeMessages) return Promise.resolve();

    return this.run(
      `
      INSERT INTO auth_messages (
        email_id, template_key, artifact_type, from_address, to_address, subject,
        service, code, url, confidence, source, created_at, raw_created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        email.id || null,
        templateKey,
        artifact.type,
        email.from,
        email.to,
        email.subject,
        service,
        artifact.code || null,
        artifact.url || null,
        confidence,
        source,
        Date.now(),
        email.createdAt || null,
      ],
    );
  }

  touchAuthTemplate(templateKey) {
    return this.run(
      `
      UPDATE auth_templates
      SET hit_count = hit_count + 1, updated_at = ?
      WHERE template_key = ?
      `,
      [Date.now(), templateKey],
    );
  }

  async saveLearnedExtractRules({ email, templateKey, artifact, extractor, confidence, source }) {
    const rules = buildLearnedExtractRules(email, artifact);
    if (extractor) {
      const aiRule = normalizeAiExtractorRule(extractor);
      if (aiRule) rules.unshift(aiRule);
    }

    for (const rule of rules) {
      await this.saveLearnedExtractRule({
        email,
        templateKey,
        artifact,
        rule,
        confidence,
        source,
      });
    }

    if (rules.length) {
      this.log(`training: simpan ${rules.length} learned split rule dari ${source}`);
    }
  }

  saveLearnedExtractRule({ email, templateKey, artifact, rule, confidence, source }) {
    const now = Date.now();

    return this.run(
      `
      INSERT INTO auth_extract_rules (
        template_key, sender_domain, subject_mask, artifact_type, field, before_text, after_text,
        regex_pattern, code_style, url_param, confidence, source, hit_count, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT(template_key, artifact_type, field, before_text, after_text) DO UPDATE SET
        sender_domain = excluded.sender_domain,
        subject_mask = excluded.subject_mask,
        regex_pattern = excluded.regex_pattern,
        code_style = excluded.code_style,
        url_param = excluded.url_param,
        confidence = excluded.confidence,
        source = excluded.source,
        updated_at = excluded.updated_at
      `,
      [
        templateKey,
        email.senderDomain,
        email.subjectMask,
        artifact.type,
        rule.field,
        rule.beforeText,
        rule.afterText,
        rule.regexPattern || null,
        detectCodeStyle(artifact.code),
        artifact.url ? detectUrlParam(artifact.url) : null,
        confidence,
        source,
        now,
        now,
      ],
    );
  }

  async extractWithLearnedRules(email, templateKey, artifactType) {
    const params = artifactType
      ? [templateKey, email.senderDomain, email.subjectMask, artifactType]
      : [templateKey, email.senderDomain, email.subjectMask];
    const artifactWhere = artifactType ? "AND artifact_type = ?" : "";
    const rules = await this.all(
      `
      SELECT * FROM auth_extract_rules
      WHERE (template_key = ? OR (sender_domain = ? AND subject_mask = ?))
      ${artifactWhere}
      ORDER BY CASE WHEN template_key = ? THEN 0 ELSE 1 END,
        confidence DESC, hit_count DESC, updated_at DESC
      `,
      [...params, templateKey],
    );

    for (const rule of rules) {
      const artifact = applyLearnedExtractRule(email, rule);
      if (!artifact) continue;

      await this.run(
        `
        UPDATE auth_extract_rules
        SET hit_count = hit_count + 1, updated_at = ?
        WHERE id = ?
        `,
        [Date.now(), rule.id],
      );

      return artifact;
    }

    return null;
  }

  async saveNonOtpTemplate({ email, templateKey, service, reason, confidence, source }) {
    const now = Date.now();

    await this.run(
      `
      INSERT INTO non_otp_templates (
        template_key, from_address, sender_domain, subject_mask, body_hash,
        service, reason, confidence, source, hit_count, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT(template_key) DO UPDATE SET
        service = excluded.service,
        reason = excluded.reason,
        confidence = excluded.confidence,
        source = excluded.source,
        updated_at = excluded.updated_at
      `,
      [
        templateKey,
        email.from,
        email.senderDomain,
        email.subjectMask,
        email.bodyHash,
        service,
        reason,
        confidence,
        source,
        now,
        now,
      ],
    );

    await this.pruneNonOtpTemplates();
  }

  touchNonOtpTemplate(templateKey) {
    return this.run(
      `
      UPDATE non_otp_templates
      SET hit_count = hit_count + 1, updated_at = ?
      WHERE template_key = ?
      `,
      [Date.now(), templateKey],
    );
  }

  pruneNonOtpTemplates() {
    if (!Number.isFinite(this.maxNonOtpTemplates) || this.maxNonOtpTemplates <= 0) {
      return Promise.resolve();
    }

    return this.run(
      `
      DELETE FROM non_otp_templates
      WHERE id NOT IN (
        SELECT id FROM non_otp_templates
        ORDER BY updated_at DESC
        LIMIT ?
      )
      `,
      [this.maxNonOtpTemplates],
    );
  }

  saveOtpMessage({ email, templateKey, code, service, confidence, source }) {
    if (!this.storeMessages) return Promise.resolve();

    return this.run(
      `
      INSERT INTO otp_messages (
        email_id, template_key, from_address, to_address, subject, service,
        otp_code, confidence, source, created_at, raw_created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        email.id || null,
        templateKey,
        email.from,
        email.to,
        email.subject,
        service,
        code,
        confidence,
        source,
        Date.now(),
        email.createdAt || null,
      ],
    );
  }

  run(sql, params = []) {
    if (this.db.kind === "node:sqlite") {
      this.db.client.prepare(sql).run(...params);
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      this.db.client.run(sql, params, function onRun(error) {
        if (error) reject(error);
        else resolve(this);
      });
    });
  }

  get(sql, params = []) {
    if (this.db.kind === "node:sqlite") {
      return Promise.resolve(this.db.client.prepare(sql).get(...params));
    }

    return new Promise((resolve, reject) => {
      this.db.client.get(sql, params, (error, row) => {
        if (error) reject(error);
        else resolve(row);
      });
    });
  }

  all(sql, params = []) {
    if (this.db.kind === "node:sqlite") {
      return Promise.resolve(this.db.client.prepare(sql).all(...params));
    }

    return new Promise((resolve, reject) => {
      this.db.client.all(sql, params, (error, rows) => {
        if (error) reject(error);
        else resolve(rows || []);
      });
    });
  }

  close() {
    if (this.db.kind === "node:sqlite") {
      this.db.client.close();
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      this.db.client.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  log(message) {
    if (!this.debug) return;
    this.logger(`[otp-filter] ${message}`);
  }
}

function openSqliteDatabase(dbPath) {
  if (DatabaseSync) {
    return { kind: "node:sqlite", client: new DatabaseSync(dbPath) };
  }

  let sqlite3;
  try {
    sqlite3 = require("sqlite3").verbose();
  } catch (error) {
    throw new Error(
      "SQLite tidak tersedia. Pakai Node 22.5+/24+ atau install fallback: npm i sqlite3",
    );
  }

  return { kind: "sqlite3", client: new sqlite3.Database(dbPath) };
}

function loadDotEnv(filePath = path.join(process.cwd(), ".env")) {
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if (!key || process.env[key] !== undefined) continue;

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

function parseEnvBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === "") return defaultValue;

  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;

  return defaultValue;
}

function normalizeEmail(email = {}) {
  const from = String(email.from || "");
  const subject = String(email.subject || "");
  const text = String(email.text || "");
  const htmlText = htmlToText(String(email.html || ""));
  const raw = String(email.raw || "");
  const compactText = compactWhitespace([subject, text, htmlText || raw.slice(0, 5000)].join("\n"));
  const senderDomain = extractSenderDomain(from);
  const service = extractServiceName(from, senderDomain, subject);
  const subjectMask = maskOtpLikeValues(subject);
  const bodyMask = maskOtpLikeValues(compactText);
  const bodyHash = sha256(bodyMask.slice(0, 12000));

  return {
    id: email.id || null,
    from,
    to: Array.isArray(email.to) ? email.to.join(",") : String(email.to || ""),
    subject,
    text,
    htmlText,
    compactText,
    senderDomain,
    service,
    subjectMask,
    bodyMask,
    bodyHash,
    createdAt: email.created_at || email.createdAt || null,
  };
}

function hasOtpHint(email) {
  const checked = `${email.from}\n${email.subject}\n${email.compactText.slice(0, 1500)}`;
  if (OTP_HINT_RE.test(checked)) return true;
  if (AUTH_LINK_HINT_RE.test(checked) && /\bhttps?:\/\//i.test(checked)) return true;
  if (NEGATIVE_HINT_RE.test(checked) && !findOtpCandidates(checked).length) return false;
  return false;
}

function extractOtpLocally(email) {
  const fields = [
    { name: "subject", text: email.subject, weight: 0.95 },
    { name: "text", text: email.text, weight: 0.9 },
    { name: "body", text: email.compactText, weight: 0.78 },
  ];

  const candidates = [];
  for (const field of fields) {
    for (const candidate of findOtpCandidates(field.text)) {
      candidates.push({
        ...candidate,
        field: field.name,
        score: candidate.score * field.weight,
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];

  return {
    code: best ? best.code : null,
    confidence: best ? Number(Math.min(best.score, 0.99).toFixed(2)) : 0,
    candidates: candidates.slice(0, 5),
  };
}

function extractAuthLinkLocally(email) {
  const fields = [
    { name: "text", text: email.text, weight: 0.95 },
    { name: "html", text: email.htmlText || "", weight: 0.9 },
    { name: "body", text: email.compactText, weight: 0.76 },
  ];

  const candidates = [];
  for (const field of fields) {
    for (const candidate of findAuthLinkCandidates(field.text)) {
      candidates.push({
        ...candidate,
        field: field.name,
        score: candidate.score * field.weight,
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];

  return {
    url: best ? best.url : null,
    code: best ? best.code : null,
    confidence: best ? Number(Math.min(best.score, 0.99).toFixed(2)) : 0,
    candidates: candidates.slice(0, 5),
  };
}

function findAuthLinkCandidates(input) {
  const text = String(input || "");
  if (!text || !/\bhttps?:\/\//i.test(text)) return [];

  const urls = extractUrls(text);
  const results = [];

  for (const url of urls) {
    const cleaned = url.replace(/[)\].,;'"<>]+$/g, "");
    const lowered = cleaned.toLowerCase();
    const code = extractCodeFromUrl(cleaned);
    const before = text.slice(Math.max(0, text.indexOf(url) - 180), text.indexOf(url));
    const after = text.slice(text.indexOf(url), text.indexOf(url) + url.length + 120);
    const context = `${before} ${after}`;

    if (/\b(unsubscribe|privacy|termsofuse|terms|help|contactus|corpinfo|notificationsettings|browse)\b/i.test(lowered)) {
      continue;
    }

    let score = 0.45;
    if (AUTH_LINK_HINT_RE.test(context)) score += 0.28;
    if (/\b(create|account|signin|sign-in|login|verify|confirm|reset|epr)\b/i.test(lowered)) score += 0.16;
    if (code) score += 0.16;
    if (/\b(expire|expires|expired|minutes?|menit|kedaluwarsa)\b/i.test(context)) score += 0.08;

    if (score >= 0.72) {
      results.push({
        url: cleaned,
        code,
        score,
        context: compactWhitespace(context).slice(0, 260),
      });
    }
  }

  return dedupeLinkCandidates(results);
}

function extractUrls(text) {
  const matches = String(text || "").match(/\bhttps?:\/\/[^\s<>"']+/gi);
  return matches || [];
}

function extractCodeFromUrl(url) {
  try {
    const parsed = new URL(url);
    for (const key of ["code", "otp", "token", "verification", "verify", "auth", "key"]) {
      const value = parsed.searchParams.get(key);
      if (value && /^[A-Za-z0-9_-]{4,128}$/.test(value)) return value;
    }
  } catch (error) {
    const match = String(url).match(/[?&](?:code|otp|token|verification|verify|auth|key)=([A-Za-z0-9_-]{4,128})/i);
    if (match) return match[1];
  }

  return null;
}

function dedupeLinkCandidates(candidates) {
  const byUrl = new Map();
  for (const item of candidates) {
    const existing = byUrl.get(item.url);
    if (!existing || item.score > existing.score) byUrl.set(item.url, item);
  }
  return Array.from(byUrl.values()).sort((a, b) => b.score - a.score);
}

function buildLearnedExtractRules(email, artifact) {
  const target = artifact.type === "link" ? artifact.url : artifact.code;
  if (!target) return [];

  const fields = [
    { field: "subject", text: email.subject },
    { field: "text", text: email.text },
    { field: "htmlText", text: email.htmlText },
    { field: "compactText", text: email.compactText },
  ];

  const rules = [];
  for (const item of fields) {
    const text = String(item.text || "");
    const index = text.indexOf(target);
    if (index === -1) continue;

    const beforeText = text.slice(Math.max(0, index - 60), index);
    const afterText = text.slice(index + target.length, index + target.length + 60);
    if (!beforeText && !afterText) continue;

    rules.push({
      field: item.field,
      beforeText: normalizeRuleText(beforeText),
      afterText: normalizeRuleText(afterText),
      regexPattern: buildRegexPatternForArtifact(artifact, beforeText, afterText),
    });
  }

  return rules;
}

function normalizeAiExtractorRule(extractor) {
  if (!extractor || !extractor.field) return null;
  if (!["subject", "text", "htmlText", "compactText"].includes(extractor.field)) return null;

  return {
    field: extractor.field,
    beforeText: normalizeRuleText(extractor.before_text || ""),
    afterText: normalizeRuleText(extractor.after_text || ""),
    regexPattern: extractor.regex_pattern ? String(extractor.regex_pattern).trim() : null,
  };
}

function buildRegexPatternForArtifact(artifact, beforeText, afterText) {
  const before = regexEscape(compactWhitespace(beforeText).slice(-40));
  const after = regexEscape(compactWhitespace(afterText).slice(0, 40));
  const capture = artifact.type === "link" ? "(https?:\\/\\/\\S+)" : codeStyleRegex(detectCodeStyle(artifact.code));

  if (before && after) return `${before}\\s*${capture}\\s*${after}`;
  if (before) return `${before}\\s*${capture}`;
  if (after) return `${capture}\\s*${after}`;
  return null;
}

function codeStyleRegex(style) {
  if (style === "ddd-ddd") return "(\\d{3}-\\d{3})";
  if (style === "digits") return "(\\d{4,10})";
  return "([A-Za-z0-9_-]{4,128})";
}

function regexEscape(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function applyLearnedExtractRule(email, rule) {
  const text = getRuleFieldText(email, rule.field);
  if (!text) return null;

  const regexArtifact = applyRegexRule(text, rule);
  if (regexArtifact) return regexArtifact;

  const before = String(rule.before_text || "");
  const after = String(rule.after_text || "");
  const normalizedText = normalizeRuleText(text);
  const startFrom = before ? normalizedText.indexOf(before) : 0;
  if (startFrom === -1) return null;

  const start = startFrom + before.length;
  const end = after ? normalizedText.indexOf(after, start) : -1;
  if (after && end === -1) return null;

  const between = normalizedText.slice(start, end === -1 ? undefined : end).trim();
  if (!between) return null;

  if (rule.artifact_type === "otp") {
    const code = extractCodeByStyle(between, rule.code_style);
    if (!code) return null;

    return {
      type: "otp",
      code,
      url: null,
      confidence: Number(rule.confidence || 0.85),
    };
  }

  if (rule.artifact_type === "link") {
    const url = extractUrls(between)[0] || between;
    if (!/^https?:\/\//i.test(url)) return null;

    return {
      type: "link",
      code: extractCodeFromUrl(url),
      url,
      confidence: Number(rule.confidence || 0.85),
    };
  }

  return null;
}

function applyRegexRule(text, rule) {
  const pattern = String(rule.regex_pattern || "").trim();
  if (!pattern) return null;

  try {
    const re = new RegExp(pattern, "i");
    const match = String(text || "").match(re);
    if (!match || !match[1]) return null;

    if (rule.artifact_type === "otp") {
      const code = String(match[1]).trim();
      if (!isValidOtpShape(code.replace(/[\s-]/g, ""))) return null;

      return {
        type: "otp",
        code,
        url: null,
        confidence: Number(rule.confidence || 0.88),
      };
    }

    if (rule.artifact_type === "link") {
      const url = String(match[1]).trim().replace(/[)\].,;'"<>]+$/g, "");
      if (!/^https?:\/\//i.test(url)) return null;

      return {
        type: "link",
        code: extractCodeFromUrl(url),
        url,
        confidence: Number(rule.confidence || 0.88),
      };
    }
  } catch (error) {
    return null;
  }

  return null;
}

function getRuleFieldText(email, field) {
  if (field === "subject") return email.subject;
  if (field === "text") return email.text;
  if (field === "htmlText") return email.htmlText;
  if (field === "compactText") return email.compactText;
  return "";
}

function normalizeRuleText(text) {
  return compactWhitespace(String(text || ""));
}

function detectCodeStyle(code) {
  const value = String(code || "");
  if (/^\d{3}-\d{3}$/.test(value)) return "ddd-ddd";
  if (/^\d{4,10}$/.test(value)) return "digits";
  if (/^[A-Za-z0-9_-]{4,128}$/.test(value)) return "alnum";
  return "any";
}

function extractCodeByStyle(text, style) {
  const value = String(text || "");
  const patterns = {
    "ddd-ddd": /\b\d{3}-\d{3}\b/,
    digits: /\b\d{4,10}\b/,
    alnum: /\b[A-Za-z0-9_-]{4,128}\b/,
    any: /\b[A-Za-z0-9_-]{4,128}\b/,
  };
  const pattern = patterns[style] || patterns.any;
  const match = value.match(pattern);
  if (!match) return null;

  const code = match[0];
  if (style !== "ddd-ddd" && !isValidOtpShape(code.replace(/[\s-]/g, ""))) return null;
  return code;
}

function detectUrlParam(url) {
  try {
    const parsed = new URL(url);
    for (const key of ["code", "otp", "token", "verification", "verify", "auth", "key"]) {
      if (parsed.searchParams.has(key)) return key;
    }
  } catch (error) {
    return null;
  }

  return null;
}

function findOtpCandidates(input) {
  const text = compactWhitespace(String(input || ""));
  if (!text) return [];

  const patterns = [
    {
      re: /\b(?:kode|otp|code|verification code|verification|verifikasi|pin)\D{0,35}([A-Z0-9][A-Z0-9 -]{3,12}[A-Z0-9])\b/gi,
      score: 0.98,
    },
    {
      re: /\b([0-9]{3}[-\s][0-9]{3})\b(?=\D{0,45}\b(?:otp|code|kode|verification|confirmation|confirm|verifikasi)\b)/gi,
      score: 0.96,
    },
    {
      re: /\b(?:otp|code|kode|verification|confirmation|confirm|verifikasi)\D{0,45}([0-9]{3}[-\s][0-9]{3})\b/gi,
      score: 0.96,
    },
    {
      re: /\b([0-9]{4,10})\b(?=\D{0,50}\b(?:menit|minutes?|minute|kedaluwarsa|expires?|valid|berlaku)\b)/gi,
      score: 0.9,
    },
    {
      re: /\b(?:masukkan|enter|gunakan|use)\D{0,25}([0-9]{4,10}|[A-Z0-9]{4,10})\b/gi,
      score: 0.9,
    },
    {
      re: /(?:^|\n|\s)([0-9]{6})(?:\s|\n|$)/g,
      score: 0.72,
    },
  ];

  const blockedNearRe = /\b(abn|nsw|pty|ltd|invoice|receipt|tagihan|privacy|policy|alamat|address|tahun|year)\b/i;
  const results = [];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern.re)) {
      const raw = String(match[1] || "").trim();
      if (/[a-z]/.test(raw)) continue;
      if (/\s/.test(raw) && /[A-Z]/i.test(raw)) continue;

      const compactCode = raw.replace(/[\s-]/g, "");
      if (!isValidOtpShape(compactCode)) continue;
      const code = raw.includes("-") ? raw.replace(/\s+/g, "") : compactCode;

      const start = Math.max(0, match.index - 45);
      const end = Math.min(text.length, match.index + match[0].length + 45);
      const context = text.slice(start, end);
      if (blockedNearRe.test(context) && !OTP_HINT_RE.test(context)) continue;

      results.push({ code, score: pattern.score, context });
    }
  }

  return dedupeCandidates(results);
}

function dedupeCandidates(candidates) {
  const byCode = new Map();
  for (const item of candidates) {
    const existing = byCode.get(item.code);
    if (!existing || item.score > existing.score) byCode.set(item.code, item);
  }
  return Array.from(byCode.values()).sort((a, b) => b.score - a.score);
}

function isValidOtpShape(code) {
  if (!/^[A-Z0-9]{4,10}$/i.test(code)) return false;
  if (/^(19|20)\d{2}$/.test(code)) return false;
  if (/^0+$/.test(code)) return false;
  return true;
}

function createTemplateKey(email) {
  return sha256([email.senderDomain, email.subjectMask, email.bodyHash].join("|"));
}

function maskOtpLikeValues(text) {
  return compactWhitespace(String(text || ""))
    .replace(/\b\d{3}[-\s]\d{3}\b/g, "<CODE>")
    .replace(/\b[A-Z0-9]{4,10}\b/gi, "<CODE>")
    .replace(/\b\d{1,3}\b/g, "<N>")
    .slice(0, 12000);
}

function htmlToText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCharCode(code) : " ";
    })
    .replace(/&[a-z]+;/gi, " ");
}

function compactWhitespace(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function extractSenderDomain(from) {
  const match = String(from || "").match(/@([A-Z0-9.-]+\.[A-Z]{2,})/i);
  return match ? match[1].toLowerCase() : "";
}

function extractServiceName(from, domain, subject) {
  const quoted = String(from || "").match(/"([^"]+)"/);
  if (quoted && quoted[1]) return quoted[1].trim();

  const plain = String(from || "").match(/^([^<@]+)</);
  if (plain && plain[1]) return plain[1].trim();

  if (domain) {
    const first = domain.split(".").filter((part) => !["mail", "email", "no-reply", "noreply"].includes(part))[0];
    if (first) return first.charAt(0).toUpperCase() + first.slice(1);
  }

  const subjectService = String(subject || "").match(/\b(?:kode|code|otp)\s+([A-Z][A-Za-z0-9._-]{2,})\b/);
  return subjectService ? subjectService[1] : null;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function collectResponseText(data) {
  if (typeof data.output_text === "string") return data.output_text;

  const chunks = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) chunks.push(content.text);
    }
  }

  return chunks.join("").trim();
}

function buildAuthResult({ artifact, service, source, templateKey, confidence }) {
  const isOtp = artifact.type === "otp";

  return {
    isOtp,
    isAuth: true,
    type: artifact.type,
    otp: isOtp ? artifact.code : null,
    code: artifact.code || null,
    url: artifact.url || null,
    service,
    source,
    templateKey,
    confidence,
  };
}

async function fetchEmailMessage(url, fetchOptions = {}) {
  if (!url || typeof url !== "string") {
    throw new Error("URL message API wajib berupa string.");
  }

  const response = await fetch(url, {
    method: fetchOptions.method || "GET",
    headers: {
      Accept: "application/json",
      ...(fetchOptions.headers || {}),
    },
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Gagal fetch message ${response.status}: ${detail}`);
  }

  const data = await response.json();
  return data && data.data && typeof data.data === "object" ? data.data : data;
}

module.exports = {
  createOtpFilter,
  fetchEmailMessage,
  normalizeEmail,
  extractOtpLocally,
  extractAuthLinkLocally,
};

if (require.main === module) {
  const chunks = [];
  const messageUrl = process.argv[2];
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => chunks.push(chunk));
  process.stdin.on("end", async () => {
    const filter = createOtpFilter();

    try {
      const input = chunks.join("").trim();
      const result = messageUrl
        ? await filter.filterUrl(messageUrl)
        : await filter.filterEmail(input ? JSON.parse(input) : {});

      console.log(JSON.stringify(result, null, 2));
    } finally {
      await filter.close();
    }
  });
}

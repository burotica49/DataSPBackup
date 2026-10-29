import nodemailer from "nodemailer";
import { logger } from "../../lib/logger.js";
import { channels } from "../../models/repo.js";
import { decryptString } from "../crypto/crypto.js";
import type {
  NotificationChannel,
  NotifyEvent,
} from "../../types/models.js";

/**
 * Envoi de notifications multi-canaux. Les appels ne lèvent JAMAIS vers le
 * cycle de sauvegarde : une erreur de notification est journalisée, pas
 * propagée. Aucune valeur de config (jeton, mot de passe SMTP) n'est logguée.
 */

export interface NotifyPayload {
  title: string;
  message: string;
  level: "info" | "success" | "error";
}

interface TelegramConfig {
  botToken: string;
  chatId: string;
}
interface WebhookConfig {
  url: string;
  headers?: Record<string, string>;
}
interface EmailConfig {
  host: string;
  port: number;
  secure?: boolean;
  user?: string;
  pass?: string;
  from: string;
  to: string;
}

function configOf<T>(channel: NotificationChannel): T {
  return JSON.parse(channel.config_enc ? decryptString(channel.config_enc) : "{}") as T;
}

async function sendTelegram(cfg: TelegramConfig, p: NotifyPayload): Promise<void> {
  const emoji = p.level === "error" ? "❌" : p.level === "success" ? "✅" : "▶️";
  const res = await fetch(
    `https://api.telegram.org/bot${cfg.botToken}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: cfg.chatId,
        text: `${emoji} *${p.title}*\n${p.message}`,
        parse_mode: "Markdown",
      }),
    },
  );
  if (!res.ok) {
    throw new Error(`Telegram HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

async function sendWebhook(cfg: WebhookConfig, p: NotifyPayload): Promise<void> {
  const res = await fetch(cfg.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cfg.headers ?? {}) },
    body: JSON.stringify({
      title: p.title,
      message: p.message,
      level: p.level,
      source: "dataspbackup",
      at: new Date().toISOString(),
    }),
  });
  if (!res.ok) throw new Error(`Webhook HTTP ${res.status}`);
}

async function sendEmail(cfg: EmailConfig, p: NotifyPayload): Promise<void> {
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure ?? cfg.port === 465,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
  });
  await transport.sendMail({
    from: cfg.from,
    to: cfg.to,
    subject: `[dataspbackup] ${p.title}`,
    text: p.message,
  });
}

async function sendTo(channel: NotificationChannel, p: NotifyPayload): Promise<void> {
  switch (channel.type) {
    case "telegram":
      return sendTelegram(configOf<TelegramConfig>(channel), p);
    case "webhook":
      return sendWebhook(configOf<WebhookConfig>(channel), p);
    case "email":
      return sendEmail(configOf<EmailConfig>(channel), p);
    default:
      throw new Error(`Type de canal inconnu: ${channel.type}`);
  }
}

function wants(channel: NotificationChannel, event: NotifyEvent): boolean {
  if (event === "start") return channel.on_start === 1;
  if (event === "success") return channel.on_success === 1;
  return channel.on_failure === 1;
}

/** Diffuse un événement à tous les canaux activés qui l'ont souscrit. */
export async function notifyEvent(
  event: NotifyEvent,
  p: NotifyPayload,
): Promise<void> {
  const targets = channels.listEnabled().filter((c) => wants(c, event));
  await Promise.all(
    targets.map(async (c) => {
      try {
        await sendTo(c, p);
      } catch (err) {
        logger.warn(
          { channelId: c.id, type: c.type, err: String(err) },
          "Échec d'envoi de notification",
        );
      }
    }),
  );
}

/** Envoie un message de test sur un canal précis (ignore les souscriptions). */
export async function testChannel(id: number): Promise<void> {
  const channel = channels.get(id);
  if (!channel) throw new Error("Canal introuvable");
  await sendTo(channel, {
    title: "Test de notification",
    message: "Si vous lisez ceci, le canal dataspbackup est bien configuré.",
    level: "info",
  });
}

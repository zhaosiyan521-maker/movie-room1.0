import nodemailer, { Transporter } from 'nodemailer';
import { config } from '../config';

const smtp = config.smtp;
const isConfigured = Boolean(smtp.host && smtp.user);

/** 是否已配置真实 SMTP。未配置时系统不真正发信，仅在控制台输出链接。 */
export const emailConfigured = isConfigured;

let transporter: Transporter | null = null;
if (isConfigured) {
  transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.user && smtp.pass ? { user: smtp.user, pass: smtp.pass } : undefined
  });
}

const PURPOSE_LABELS: Record<string, string> = {
  'register': '注册账号',
  'change-password': '修改密码',
  'bind-email': '绑定邮箱'
};

/**
 * 发送邮箱验证链接邮件。
 * 若未配置 SMTP，则在服务端控制台打印链接，方便本地联调（不会真正发信）。
 */
export async function sendVerificationLink(email: string, link: string, purpose: string): Promise<void> {
  const label = PURPOSE_LABELS[purpose] || '验证邮箱';
  const subject = `Movie Room 邮箱验证：${label}`;
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#222">
      <h2 style="margin:0 0 12px">Movie Room 邮箱验证</h2>
      <p>你正在执行「${label}」操作。请点击下方按钮完成验证（链接 ${config.emailVerifyTtlSec / 60} 分钟内有效）：</p>
      <p style="margin:20px 0">
        <a href="${link}" style="background:#e11d48;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block">点击完成验证</a>
      </p>
      <p style="color:#888;font-size:13px">若按钮无法点击，请复制以下链接到浏览器打开：</p>
      <p style="color:#888;font-size:13px;word-break:break-all">${link}</p>
      <hr style="border:none;border-top:1px solid #eee;margin:20px 0" />
      <p style="color:#aaa;font-size:12px">如果这不是你本人的操作，请忽略此邮件。</p>
    </div>
  `;

  if (!transporter) {
    console.log(`\n[邮件] SMTP 未配置，验证链接仅在控制台输出（收件人 ${email} / ${label}）：\n${link}\n`);
    return;
  }

  await transporter.sendMail({
    from: smtp.from || smtp.user,
    to: email,
    subject,
    html
  });
}

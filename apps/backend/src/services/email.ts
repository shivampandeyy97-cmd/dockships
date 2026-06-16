import nodemailer from 'nodemailer';
import axios from 'axios';
import { getRow } from '../db';
import dotenv from 'dotenv';

dotenv.config();

export interface SendEmailOptions {
  to: string;
  subject: string;
  body: string;
  service?: 'smtp' | 'gmail' | 'mailgun';
  gmailConfig?: {
    user: string;
    pass: string;
  };
}

interface SmtpSettings {
  user_id: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  sender_name?: string;
  sender_email: string;
  mailgun_api_key?: string;
  mailgun_domain?: string;
  active_service?: 'smtp' | 'mailgun';
}

/**
 * Sends outreach email using user's saved SMTP settings, Mailgun API, custom dynamic Gmail input, or falls back to default Mailgun / mock.
 */
export async function sendOutreachEmail(
  options: SendEmailOptions,
  userId: string
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    // Case 1: Custom dynamic Gmail input from outreach modal
    if (options.service === 'gmail' && options.gmailConfig?.user && options.gmailConfig?.pass) {
      console.log(`Using dynamic Gmail SMTP transport for user: ${options.gmailConfig.user}`);
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: options.gmailConfig.user,
          pass: options.gmailConfig.pass
        }
      });
      const fromAddress = options.gmailConfig.user;

      const mailOptions = {
        from: fromAddress,
        to: options.to,
        subject: options.subject,
        text: options.body.replace(/<[^>]*>/g, ''), // Strip tags for plain text
        html: options.body
      };

      const info = await transporter.sendMail(mailOptions);
      console.log('Gmail sent successfully:', info.messageId || info);

      return {
        success: true,
        messageId: info.messageId || 'mock-id-success'
      };
    } 

    // Case 2: Fetch user settings from SQLite database
    const settings = await getRow<SmtpSettings>(
      'SELECT * FROM dockships_smtp_settings WHERE user_id = ?',
      [userId]
    );

    // Resolve Mailgun Credentials (use saved settings, falling back to process.env defaults)
    const mailgunApiKey = settings?.mailgun_api_key || process.env.MAILGUN_API_KEY;
    const mailgunDomain = settings?.mailgun_domain || process.env.MAILGUN_DOMAIN;
    const mailgunBaseUrl = process.env.MAILGUN_BASE_URL || 'https://api.mailgun.net';
    const senderEmail = settings?.sender_email || process.env.DEFAULT_SENDER_EMAIL || 'contact@rollinhead.com';
    const senderName = settings?.sender_name || 'Dockships Outreach';

    const isMailgunActive = settings?.active_service === 'mailgun' || options.service === 'mailgun' || (!settings && !!mailgunApiKey);

    // Subcase 2A: Mailgun API Dispatcher (Active either by user settings, or as default fallback)
    if (isMailgunActive) {
      console.log(`Using Mailgun API configuration: domain = ${mailgunDomain}`);
      if (!mailgunApiKey || !mailgunDomain) {
        throw new Error('Mailgun configuration is missing API key or Domain. Configure them in Settings or .env first.');
      }

      const authHeader = 'Basic ' + Buffer.from(`api:${mailgunApiKey}`).toString('base64');
      const postData = new URLSearchParams();
      const fromAddress = senderName 
        ? `"${senderName}" <${senderEmail}>`
        : senderEmail;

      postData.append('from', fromAddress);
      postData.append('to', options.to);
      postData.append('subject', options.subject);
      postData.append('text', options.body.replace(/<[^>]*>/g, ''));
      postData.append('html', options.body);

      const response = await axios.post(
        `${mailgunBaseUrl}/v3/${mailgunDomain}/messages`,
        postData,
        {
          headers: {
            'Authorization': authHeader,
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }
      );

      console.log('Mailgun API sent successfully:', response.data);
      return {
        success: true,
        messageId: response.data.id || 'mailgun-success-id'
      };
    } 
    
    // Subcase 2B: Standard SMTP Dispatcher (if settings exist and SMTP is active)
    if (settings && settings.active_service === 'smtp' && settings.host && settings.port && settings.username && settings.password) {
      console.log(`Using saved SMTP configuration: ${settings.host}:${settings.port}`);
      const transporter = nodemailer.createTransport({
        host: settings.host,
        port: settings.port,
        secure: settings.port === 465,
        auth: {
          user: settings.username,
          pass: settings.password
        }
      });
      const fromAddress = settings.sender_name 
        ? `"${settings.sender_name}" <${settings.sender_email}>`
        : settings.sender_email;

      const mailOptions = {
        from: fromAddress,
        to: options.to,
        subject: options.subject,
        text: options.body.replace(/<[^>]*>/g, ''),
        html: options.body
      };

      const info = await transporter.sendMail(mailOptions);
      console.log('SMTP sent successfully:', info.messageId || info);

      return {
        success: true,
        messageId: info.messageId || 'mock-id-success'
      };
    }

    // Case 3: Fallback to Mock logs if no settings or default Mailgun is configured
    console.log(`⚠️ User ${userId} has no email settings configured. Logging email output to console only.`);
    console.log(`============== MOCK EMAIL OUTREACH ==============`);
    console.log(`To: ${options.to}`);
    console.log(`Subject: ${options.subject}`);
    console.log(`Body: ${options.body}`);
    console.log(`=================================================`);
    
    return {
      success: true,
      messageId: `mock-dispatch-${Date.now()}`
    };
  } catch (err: any) {
    console.error('Error in sendOutreachEmail service:', err);
    return {
      success: false,
      error: err.response?.data?.message || err.message || 'Transmission failed. Verify your mail settings.'
    };
  }
}

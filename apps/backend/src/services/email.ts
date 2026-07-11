import nodemailer from 'nodemailer';
import axios from 'axios';
import { getRow } from '../db';
import dotenv from 'dotenv';

dotenv.config();

export interface SendEmailOptions {
  to: string;
  subject: string;
  body: string;
  service?: 'smtp' | 'gmail';
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
  active_service?: 'smtp' | 'gmail';
}

/**
 * Sends outreach email using user's saved SMTP settings, custom dynamic Gmail input, or falls back to mock console logs.
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

    // Subcase 2A: Saved Gmail Dispatcher
    if (settings && settings.active_service === 'gmail' && settings.username && settings.password) {
      console.log(`Using saved Gmail SMTP configuration for user: ${settings.username}`);
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: settings.username,
          pass: settings.password
        }
      });
      const fromAddress = settings.sender_name 
        ? `"${settings.sender_name}" <${settings.username}>`
        : settings.username;

      const mailOptions = {
        from: fromAddress,
        to: options.to,
        subject: options.subject,
        text: options.body.replace(/<[^>]*>/g, ''),
        html: options.body
      };

      const info = await transporter.sendMail(mailOptions);
      console.log('Saved Gmail sent successfully:', info.messageId || info);

      return {
        success: true,
        messageId: info.messageId || 'mock-id-success'
      };
    }

    // Subcase 2B: Standard SMTP Dispatcher (if settings exist and SMTP is active)
    if (settings && settings.active_service === 'smtp' && settings.host && settings.port && settings.username && settings.password) {
      console.log(`Using saved SMTP configuration: ${settings.host}:${settings.port}`);
      
      const transportConfig: any = {};
      if (settings.host.toLowerCase().includes('gmail.com') || settings.host.toLowerCase().includes('googlemail.com')) {
        console.log('Detected Gmail SMTP Host. Using dedicated service config.');
        transportConfig.service = 'gmail';
      } else {
        transportConfig.host = settings.host;
        transportConfig.port = settings.port;
        transportConfig.secure = settings.port === 465;
      }
      
      transportConfig.auth = {
        user: settings.username,
        pass: settings.password
      };
      
      const transporter = nodemailer.createTransport(transportConfig);
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

    // Case 3: Fallback to environment variables SMTP configurations
    const envHost = process.env.SMTP_HOST;
    const envPort = process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : 587;
    const envUser = process.env.SMTP_USER;
    const envPass = process.env.SMTP_PASS;
    const envFrom = process.env.SMTP_FROM || 'Dockships <contact@rollinhead.com>';

    if (envHost && envUser && envPass) {
      console.log(`Using environment SMTP configuration: ${envHost}:${envPort}`);
      const transporter = nodemailer.createTransport({
        host: envHost,
        port: envPort,
        secure: envPort === 465,
        auth: {
          user: envUser,
          pass: envPass
        }
      });

      const mailOptions = {
        from: envFrom,
        to: options.to,
        subject: options.subject,
        text: options.body.replace(/<[^>]*>/g, ''),
        html: options.body
      };

      const info = await transporter.sendMail(mailOptions);
      console.log('Environment SMTP sent successfully:', info.messageId || info);

      return {
        success: true,
        messageId: info.messageId || 'env-id-success'
      };
    }

    // Case 4: Fallback to Mock logs
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

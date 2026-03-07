import { Resend } from 'resend';

let resendClient: Resend | null = null;
let sesClient: { client: any; SendEmailCommand: any } | null = null;

function getResendClient(): Resend | null {
    if (!process.env.RESEND_API_KEY) return null;
    if (!resendClient) {
        resendClient = new Resend(process.env.RESEND_API_KEY);
    }
    return resendClient;
}

async function getSesClient(): Promise<{ client: any; SendEmailCommand: any } | null> {
    if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) return null;
    if (!sesClient) {
        try {
            const { SESClient, SendEmailCommand } = await import('@aws-sdk/client-ses');
            sesClient = {
                client: new SESClient({
                    region: process.env.AWS_SES_REGION || 'us-east-1',
                    credentials: {
                        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
                        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
                    },
                }),
                SendEmailCommand,
            };
        } catch {
            return null;
        }
    }
    return sesClient;
}

const FROM_EMAIL = process.env.EMAIL_FROM_ADDRESS
    || process.env.AWS_SES_FROM_EMAIL
    || 'noreply@soulbyte.fun';

export async function sendVerificationEmail(to: string, code: string): Promise<void> {
    const subject = 'Soulbyte - Verification Code';
    const html = `
        <div style="font-family: monospace; max-width: 480px; margin: 0 auto; padding: 24px;">
            <h2 style="color: #c8a96e;">Soulbyte</h2>
            <p>Your verification code is:</p>
            <p style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #222; background: #f5f0e8; padding: 16px; text-align: center; border-radius: 8px;">${code}</p>
            <p style="color: #888; font-size: 13px;">This code expires in 15 minutes. If you didn't request this, ignore this email.</p>
        </div>
    `;

    const resend = getResendClient();
    if (resend) {
        try {
            const result = await resend.emails.send({
                from: `Soulbyte <${FROM_EMAIL}>`,
                to,
                subject,
                html,
            });
            if (result.error) {
                console.error('[EMAIL] Resend returned error:', result.error.message);
            } else {
                console.log('[EMAIL] Sent via Resend to', to);
                return;
            }
        } catch (err: any) {
            console.error('[EMAIL] Resend failed:', err.message);
        }
    }

    const ses = await getSesClient();
    if (ses) {
        try {
            const command = new ses.SendEmailCommand({
                Source: FROM_EMAIL,
                Destination: { ToAddresses: [to] },
                Message: {
                    Subject: { Data: subject },
                    Body: { Html: { Data: html } },
                },
            });
            await ses.client.send(command);
            console.log('[EMAIL] Sent via SES to', to);
            return;
        } catch (err: any) {
            console.error('[EMAIL] SES failed:', err.message);
        }
    }

    throw new Error('Email delivery failed: no provider available or all providers returned errors');
}

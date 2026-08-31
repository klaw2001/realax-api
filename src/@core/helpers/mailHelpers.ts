import logger from '../services/LoggingService'
import nodemailer from 'nodemailer'

interface mailOptions {
    to: string,
    from?: string | undefined | null,
    subject: string,
    body: string | undefined | null
}

const mail = nodemailer.createTransport({
    host: process.env.MAIL_HOST,
    port: process.env.MAIL_PORT,
    secure: false, // true for 465, false for other ports
    auth: {
        user: process.env.MAIL_USER, // generated ethereal user
        pass: process.env.MAIL_PASSWORD, // generated ethereal password
    },
})

export async function sendMail(options: mailOptions) {

    try {

        const mailOptions: any = {
            from: options.from ? options.from : 'yusuf@aliff.in',
            to: options.to,
            subject: options.subject,
            html: options.body,
        }

        mail.sendMail(mailOptions, function (error: any, info: any) {

            if (error) {
                logger.consoleErrorLog('mailHelpers.js', 'Error in sendEmail', error)
            } else {
                logger.consoleInfoLog('mailHelpers.js', `Mail Sent ${JSON.stringify(info)}`)
            }
        })

    } catch (error) {
        logger.consoleErrorLog('mailHelpers.ts', 'Error in sendMail', error)
    }
}

import crypto from 'crypto'
import logger from '../services/LoggingService'

const algorithm = 'aes-128-ccm'

export function hash(plainText: string) {
    try {
        return crypto.createHash('md5').update(plainText).digest('hex')
    } catch (error) {
        logger.consoleErrorLog('core SECURITY', 'Error in hash', error)
        return ''
    }
}


export function encrypt(plainText: string) {
    try {

        if (!process.env.ENCRYPT_IV || !process.env.ENCRYPT_KEY) {
            throw new Error('ENCRYPT_IV or ENCRYPT_KEY not defined in env')
        }

         
        const iv = Buffer.from(process.env.ENCRYPT_IV, 'hex')
         
        const key = Buffer.from(process.env.ENCRYPT_KEY, 'hex')

        const crypt = crypto.createCipheriv(algorithm, key, iv).update(plainText)
         
        return Buffer.concat([crypt]).toString('hex')
    } catch (error) {
        logger.consoleErrorLog('core SECURITY', 'Error in hash', error)
        return ''
    }
}

export function decrypt(cipherText: string) {
    try {


        if (!process.env.ENCRYPT_IV || !process.env.ENCRYPT_KEY) {
            throw new Error('ENCRYPT_IV or ENCRYPT_KEY not defined in env')
        }

         
        const iv = Buffer.from(process.env.ENCRYPT_IV, 'hex')
         
        const key = Buffer.from(process.env.ENCRYPT_KEY, 'hex')

         
        const encryptedText = Buffer.from(cipherText, 'hex')
        const decrypt = crypto.createDecipheriv(algorithm, key, iv).update(encryptedText)
         
        return Buffer.concat([decrypt]).toString()
    } catch (error) {
        logger.consoleErrorLog('core SECURITY', 'Error in hash', error)
        return ''
    }
}


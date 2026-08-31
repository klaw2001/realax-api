import winston, { Logger } from 'winston'

import logType from '@core/enum/logType'
import { error } from 'console'

class LoggingService {

	DEBUG_LOGGING_ON: boolean
	logger: Logger

	constructor() {
		 
		this.DEBUG_LOGGING_ON = (process.env.MODE && process.env.MODE) === 'production' ? false : true
		this.logger = winston.createLogger({
			levels: winston.config.npm.levels,
			level: logType.DEBUG,
			format: winston.format.combine(
				winston.format.timestamp(),
				winston.format.json(),
			),
			transports: [
				new winston.transports.Console(),
				new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
				new winston.transports.File({ filename: 'logs/info.log', level: 'info' }),
				new winston.transports.File({ filename: 'logs/combined.log' })
			]
		})
	}

	getWinstonLogger() {
		return this.logger
	}

	consoleLog(route: string, message: string, error = null, level = logType.VERBOSE) {
		if (error || level == logType.ERROR || level == logType.WARNING) {
			this.consoleErrorLog(route, message, error)
		} else if (level == logType.VERBOSE || level == logType.INFO || level == logType.DEBUG) {
			this.consoleInfoLog(route, message)
		}
	}

	consoleErrorLog(route: string, message: string, error: any) {
		console.log(error)

		if (!this.DEBUG_LOGGING_ON) {console.log({ route, message, error })}
		this.logger.error({ route, message, error: JSON.stringify(error) })
	}

	consoleInfoLog(route: string, message: string) {
		if (!this.DEBUG_LOGGING_ON) {console.log({ route, message })}
		this.logger.info({ route, message })
	}
}

const logger = new LoggingService()
export default logger

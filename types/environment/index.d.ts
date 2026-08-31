import { Secret } from "jsonwebtoken";

declare global {
    namespace NodeJS {
        interface ProcessEnv {
            TZ: string;
            MODE: 'development' | 'production';
            PORT: number;
            OS: 'linux' | 'windows' | 'mac';
            ADMIN_USERID: number;
            
            DATABASE_URL: string;

            DB_HOST: string;
            DB_USER: string;
            DB_PASSWORD: string;
            DB_NAME: string;
            DB_PORT: number;

            MAIL_HOST: string;
            MAIL_PORT: number;
            MAIL_USER: string;
            MAIL_PASSWORD: string;

            JWT_ACCESS_SECRET: Secret;
            JWT_ACCESS_TOKEN_EXPIRE: string;
            JWT_REFRESH_SECRET: Secret;
            JWT_REFRESH_TOKEN_EXPIRE: string;

            ENCRYPT_KEY: string;
            ENCRYPT_IV: string;

            FILES_BASEURL: string;
            API_BASEURL?: string;
            DASHBOARD_BASEURL?: string;

            TWILIO_ACCOUNT_SID: string;
            TWILIO_AUTH_TOKEN: string;

            DEEPGRAM_KEY: string;
            OPENAI_KEY: string;
            GEMINI_KEY: string;

            AZURE_OPENAI_ENDPOINT: string;
            AZURE_OPENAI_REGION: string;
            AZURE_OPENAI_APIKEY: string;

            PINECONE_API_KEY: string;
        }
    }
}

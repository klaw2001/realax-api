FROM node:18

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
# A wildcard is used to ensure both package.json AND package-lock.json are copied
# where available (npm@5+)
COPY package*.json ./

RUN npm install
# If you are building your code for production
# RUN npm ci --omit=dev

COPY .env ./.env
COPY prisma ./prisma/

RUN npm i -g prisma

COPY . .

RUN npx prisma generate --schema ./prisma/schema.prisma

EXPOSE 8007

# CMD ["npx", "prisma", "generate"]

CMD [ "npm", "run", "start" ]
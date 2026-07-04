# Build stage
FROM node:20-alpine AS builder

# Install openssl for Prisma compatibility on alpine
RUN apk add --no-cache openssl

WORKDIR /app

# Copy package management files
COPY package*.json ./

# Install development and production dependencies
RUN npm install

# Copy Prisma schema and codefiles
COPY prisma ./prisma/
COPY tsconfig.json ./
COPY src ./src/

# Generate the Prisma Client
RUN npm run prisma:generate

# Build the TypeScript project
RUN npm run build

# Production runner stage
FROM node:20-alpine AS runner

RUN apk add --no-cache openssl

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8000

# Copy node_modules and built code from the builder stage
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

EXPOSE 8000

CMD ["npm", "run", "start"]

# 🧠 AI_NOTES.md — Evaluation & Engineering Notes

This document provides context on the AI collaboration workflow, architectural decisions, debugging sessions, and future extensions of the GITBOT platform.

---

## 🤖 1. AI Tools, Models, & Split of Work

* **AI System Used**: Antigravity (powered by Google Gemini models).
* **Work Division**:
  * **Developer (User)**: Drove product requirements, designed the overall deployment architecture (separating Frontend on Vercel and Backend on IONOS VPS), managed Neon DB schemas, and set up DNS configurations.
  * **AI Assistant**: Generated the boilerplate code (Express routes, Next.js components), created database migration mappings, styled the dashboard with a custom glassmorphism theme, and wrote automation scripts for deploying and testing the VPS configurations over SSH.

---

## 🏛️ 2. Key Developer Architectural Decisions

1. **Custom JWS Auth Bridge (Shared Secret JWTs)**
   * *Choice*: Instead of storing authentication sessions in a database on the frontend and querying it on the backend, we overrode NextAuth's default JWE encryption.
   * *Rationale*: We sign user payloads as standard JWS (HS256) tokens using a shared `AUTH_SECRET` / `NEXTAUTH_SECRET`. This permits the backend to verify client browser requests instantly using a stateless `jwtVerify` call. It decouples the frontend serverless layer from the backend database server, speeding up requests.
2. **VPS Docker + Nginx Reverse Proxy**
   * *Choice*: Containerized the backend with Docker, exposed on port `8000`, and proxied traffic through Nginx with Certbot SSL.
   * *Rationale*: By decoupling the application server container from the host networking layer, we prevent configuration conflicts. Running Nginx on the host allows us to use Certbot to manage SSL renewals easily without putting credentials inside containers.
3. **Idempotency Guard via X-GitHub-Delivery**
   * *Choice*: Enforced a database constraint checking for the presence of the `deliveryId` before running matching rules.
   * *Rationale*: GitHub webhooks can trigger multiple times for the same event due to retries or network drops. Restricting duplicate event processing ensures we don't spam Slack or add duplicate issue labels.

---

## 🐛 3. Key Debugging Experiences

### Bug A: The CORS Preflight Trailing-Slash Block
* **How it happened**: During early Vercel deployment, the browser client threw `net::ERR_FAILED` on api endpoints with a CORS preflight policy mismatch.
* **The Root Cause**: Under CORS specifications, browser origin matching is strict (byte-for-byte). The backend `.env` configuration had `FRONTEND_URL` set to `https://gitbot-frontend.vercel.app/` (with a trailing slash), but the browser sent `https://gitbot-frontend.vercel.app` (without a trailing slash).
* **How it was fixed**: We remove the trailing slash from the `.env` configuration file and recreated the Docker container, fixing browser preflight checks.

### Bug B: The Docker-Compose Database Override Mismatch
* **How it happened**: Local testing of webhook rule triggers worked perfectly in development but failed when run inside local Docker containers.
* **The Root Cause**: The AI generated a `docker-compose.local.yml` file that overrode the database URL to point to a containerized local Postgres service (`postgres:5432`). In contrast, our local development server was connected directly to Neon Postgres. This meant the Docker container ran on an isolated database without user credentials, rules, or webhook logs.
* **How it was fixed**: Diagnosed the issue by inspecting the running container's environment variables and comparing database content directly. We resolved it by aligning our Docker environment variables to direct to the Neon DB.

---

## 📈 4. Future System Extensions

1. **Reliable Webhook Queues (BullMQ + Redis)**: Currently, webhooks are processed synchronously. If the database goes down briefly, events will fail. Implementing a Redis-backed queue will allow us to retry failed webhook jobs gracefully.
2. **AI Label Suggester (Gemini API Integration)**: Add an optional rule action that passes issue titles/descriptions through Google Gemini to generate automated triage labels.

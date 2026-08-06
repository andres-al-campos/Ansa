# Node pinned rather than left to autodetection: better-sqlite3 is a native
# module compiled against the Node ABI, so a silent major-version bump in the
# builder is a crash at require() time, not a warning.
FROM node:22-slim

# node-gyp needs python3 and a toolchain to build better-sqlite3. node:22-slim
# ships none of them.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, as their own layer: they change far less often than
# source, so an edit to a .ts file doesn't trigger a native rebuild.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Vite inlines env vars at build time, so the Clerk publishable key has to be
# present *here*, not in the runtime environment. Without it AuthGate takes its
# no-key path and renders the app with no sign-in gate at all — an open server,
# failing open and silently. The guard below turns that into a failed build.
#
# Publishable, not secret: this key ships in the bundle by design. The secret
# key is a runtime variable and must never be a build arg.
ARG VITE_CLERK_PUBLISHABLE_KEY
ENV VITE_CLERK_PUBLISHABLE_KEY=$VITE_CLERK_PUBLISHABLE_KEY
RUN test -n "$VITE_CLERK_PUBLISHABLE_KEY" || { \
      echo "VITE_CLERK_PUBLISHABLE_KEY is empty. The build would produce an app"; \
      echo "with no sign-in gate. Set it in the Railway service variables"; \
      echo "(Clerk dashboard -> API keys -> Publishable key)."; exit 1; }

# Build the frontend into dist/, which the server serves in production.
# NODE_ENV is deliberately not set here — devDependencies (vite, typescript)
# are needed for this step, and npm ci above already installed them.
RUN npm run build

ENV NODE_ENV=production
# PORT is supplied by Railway; this is only the local-docker default.
ENV PORT=4000
EXPOSE 4000

CMD ["npm", "run", "start"]

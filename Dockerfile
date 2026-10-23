FROM quay.io/ukhomeofficedigital/hof-nodejs:24.22.0-alpine3.24-v2@sha256:d4d222c0b8b5c871745ed794edc3b3d4f1324239c6817f51afbac0a9f4f8a84c
USER root

# Setup nodejs group & nodejs user
RUN addgroup --system nodejs --gid 998 && \
    adduser --system nodejs --uid 999 --home /app/ && \
    chown -R 999:998 /app/

USER 999

WORKDIR /app

COPY --chown=999:998 . /app

RUN yarn install --frozen-lockfile --production

HEALTHCHECK --interval=5m --timeout=3s \
 CMD curl --fail http://localhost:8080 || exit 1

CMD yarn start

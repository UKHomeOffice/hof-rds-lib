FROM quay.io/ukhomeofficedigital/hof-nodejs:24.22.3_1-alpine@sha256:8533bcedc2dc86aceadaa8bab422931e8a33a81504c67247392eeffec6603cd5
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

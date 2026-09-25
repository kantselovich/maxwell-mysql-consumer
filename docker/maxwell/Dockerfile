FROM --platform=linux/amd64 zendesk/maxwell:v1.46.0 AS upstream

FROM --platform=$BUILDPLATFORM maven:3.9.9-eclipse-temurin-21 AS dependencies
WORKDIR /build
COPY pubsub-pom.xml pom.xml
RUN mvn -B -q org.apache.maven.plugins:maven-dependency-plugin:3.8.1:copy-dependencies -DoutputDirectory=/pubsub-lib
COPY --from=upstream /app/lib /maxwell-lib
ADD --checksum=sha256:2440093b32d00cb1ca65a22979a5666ba94cb1ecca6067b57f7f3d692670bc66 https://raw.githubusercontent.com/zendesk/maxwell/v1.46.0/src/main/java/com/zendesk/maxwell/producer/MaxwellPubsubProducer.java /tmp/MaxwellPubsubProducer.java
# DDL and DML share one Publisher. Upstream closes it twice during shutdown.
RUN sed -i 's/if ( ddlPubsub != null )/if ( ddlPubsub != null \&\& ddlPubsub != pubsub )/' /tmp/MaxwellPubsubProducer.java \
    && mkdir /pubsub-patch \
    && javac -cp '/pubsub-lib/*:/maxwell-lib/*' -d /pubsub-patch /tmp/MaxwellPubsubProducer.java

# Maxwell is Java: run it natively, even though its distribution image is amd64.
FROM eclipse-temurin:21.0.7_6-jre-jammy
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=upstream --chown=1000:1000 /app /app
# The stock image mixes incompatible Google libraries (gax 2.31.0 / Pub/Sub
# 1.132.3). Prepend Pub/Sub's own resolved dependency graph to the classpath.
COPY --from=dependencies /pubsub-lib /app/pubsub-lib
COPY --from=dependencies /pubsub-patch /app/pubsub-patch
USER 1000
ENV CLASSPATH="/app/pubsub-patch:/app/pubsub-lib/*"
CMD ["bin/maxwell", "--config=/etc/maxwell/config.properties"]

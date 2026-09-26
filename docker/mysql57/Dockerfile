# MySQL 5.7 is amd64-only; Compose selects that platform on ARM hosts.
FROM mysql:5.7.42-debian@sha256:8ba532f113f22d112fd3f8cbf9173c2a151c8699c968238cb0a6442818427fbf

# The bundled Go-based gosu can hang under QEMU before mysqld starts.
# Keep the upstream ownership/init logic, replacing only its exec handoff
# with util-linux setpriv (already present; no extra downloads/packages).
# Fail the build if the pinned entrypoint no longer matches our expectation.
RUN set -eux; \
    command -v setpriv; \
    test "$(grep -Fc 'exec gosu mysql "$BASH_SOURCE" "$@"' /usr/local/bin/docker-entrypoint.sh)" -eq 1; \
    sed -i 's/exec gosu mysql /exec setpriv --reuid=mysql --regid=mysql --init-groups -- /' /usr/local/bin/docker-entrypoint.sh; \
    if grep -q 'exec gosu' /usr/local/bin/docker-entrypoint.sh; then exit 1; fi; \
    test "$(setpriv --reuid=mysql --regid=mysql --init-groups -- id -u)" = "$(id -u mysql)"

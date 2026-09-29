export function integrationTargets() {
  const apiValue = process.env.PHONEMAIL_TEST_URL;
  const databaseValue = process.env.DATABASE_URL;
  if (!apiValue || !databaseValue) {
    throw new Error("Integration tests require explicit PHONEMAIL_TEST_URL and DATABASE_URL targets");
  }

  const api = new URL(apiValue);
  const database = new URL(databaseValue);
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  const allowedTargets: Record<string, string> = {
    "3311": "3310",
    "3331": "3330",
    "3332": "3330",
    "3343": "3330",
    "3344": "3330",
    "3351": "3350",
    "3352": "3350",
    "3353": "3350",
  };
  const targetProject = process.env.PHONEMAIL_TEST_TARGET;
  const isDisposableNetworkTarget = targetProject === "phonemail-stage3-disposable" &&
    (
      (api.hostname === "backend" && api.port === "3000") ||
      (api.hostname === "backend2" && api.port === "3000") ||
      (api.hostname === "backendpool" && api.port === "3000") ||
      (api.hostname === "worker" && api.port === "3000") ||
      (api.hostname === "127.0.0.1" && api.port === "3344")
    ) &&
    database.hostname === "db" && database.port === "5432";
  const expectedDatabasePort = allowedTargets[api.port];
  const isLoopbackTarget = api.protocol === "http:" && loopbackHosts.has(api.hostname) && !!expectedDatabasePort &&
    !(targetProject === "phonemail-stage3-disposable" && api.port === "3344");
  if (api.protocol !== "http:" || (!isLoopbackTarget && !isDisposableNetworkTarget)) {
    throw new Error("Integration API target must be one of the explicitly isolated loopback test deployments");
  }
  if (!["postgres:", "postgresql:"].includes(database.protocol) ||
      (isLoopbackTarget && (database.hostname !== api.hostname || !loopbackHosts.has(database.hostname) || database.port !== expectedDatabasePort)) ||
      (isDisposableNetworkTarget && (database.hostname !== "db" || database.port !== "5432")) ||
      decodeURIComponent(database.pathname.slice(1)) !== "phonemail_test" ||
      decodeURIComponent(database.username) !== "phonemail_test") {
    throw new Error("Integration database target must match the API's verified loopback test deployment");
  }

  const secondaryValue = process.env.PHONEMAIL_TEST_SECONDARY_URL ??
    (api.hostname === "127.0.0.1" && api.port === "3331" ? "http://127.0.0.1:3332" :
      api.hostname === "127.0.0.1" && api.port === "3351" ? "http://127.0.0.1:3352" : undefined);
  if (secondaryValue) {
    const secondary = new URL(secondaryValue);
    const validLoopbackSecondary = isLoopbackTarget &&
      ((api.port === "3331" && secondary.origin === "http://127.0.0.1:3332") ||
       (api.port === "3351" && secondary.origin === "http://127.0.0.1:3352"));
    const validDisposableSecondary = isDisposableNetworkTarget &&
      secondary.origin === "http://backend2:3000";
    if (secondary.protocol !== "http:" || (!validLoopbackSecondary && !validDisposableSecondary)) {
      throw new Error("Integration secondary API must be the explicitly isolated second instance");
    }
  }

  return { base: api.origin, databaseUrl: databaseValue, secondaryBase: secondaryValue };
}

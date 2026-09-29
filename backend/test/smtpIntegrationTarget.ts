import { readFileSync } from "node:fs";

type SmtpDemoResources = {
  Project?: string;
  Ports?: { Api?: number; Database?: number; Mailpit?: number; Inbound?: number };
  ContainerIds?: string[];
  VolumeNames?: string[];
  NetworkIds?: string[];
};

export function smtpDemoIntegrationTargets() {
  if (process.env.PHONEMAIL_SMTP_TEST_TARGET !== "phonemail-smtp-demo") {
    throw new Error("SMTP integration tests require the explicit phonemail-smtp-demo target");
  }
  const manifestPath = process.env.PHONEMAIL_SMTP_RESOURCE_FILE;
  const apiValue = process.env.PHONEMAIL_TEST_URL;
  const databaseValue = process.env.DATABASE_URL;
  if (!manifestPath || !apiValue || !databaseValue) {
    throw new Error("SMTP integration tests require their owned resource manifest, API, and database targets");
  }

  const manifestText = readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, "");
  let resources: SmtpDemoResources;
  try {
    resources = JSON.parse(manifestText) as SmtpDemoResources;
  } catch (error) {
    throw new Error("SMTP integration resource manifest is invalid", { cause: error });
  }
  if (resources.Project !== "phonemail-smtp-demo" ||
      !resources.ContainerIds?.length || resources.ContainerIds.length !== 3 ||
      !resources.VolumeNames?.length || resources.VolumeNames.length !== 3 ||
      !resources.NetworkIds?.length || resources.NetworkIds.length !== 1 ||
      !resources.Ports || Object.values(resources.Ports).some(
        (port) => typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535,
      )) {
    throw new Error("SMTP integration resource manifest does not describe the owned three-service demo stack");
  }

  const api = new URL(apiValue);
  const database = new URL(databaseValue);
  if (api.origin !== "http://backend:3000" ||
      !["postgres:", "postgresql:"].includes(database.protocol) ||
      database.hostname !== "db" || database.port !== "5432" ||
      decodeURIComponent(database.username) !== "phonemail_smtp_demo" ||
      decodeURIComponent(database.pathname.slice(1)) !== "phonemail_smtp_demo") {
    throw new Error("SMTP integration target must be the owned Compose backend and its dedicated demo database");
  }
  return { base: api.origin, databaseUrl: databaseValue };
}

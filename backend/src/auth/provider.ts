export type AuthMethod = "password" | "otp";

export type AuthUserRecord = {
  id: string;
  phoneNormalized: string;
  passwordHash: string;
};

export interface AuthProvider {
  readonly method: AuthMethod;
  /**
   * Password: hashes the secret for storage.
   * OTP (later): unused; Twilio Verify holds the secret.
   */
  prepareSecret(secret: string): Promise<string | null>;
  verify(user: AuthUserRecord, secret: string): Promise<boolean>;
  requestCode?(phoneNormalized: string): Promise<void>;
}

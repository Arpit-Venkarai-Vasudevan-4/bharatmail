UPDATE otp_challenges
   SET verification_state = 'ambiguous'
 WHERE verification_state = 'authorized'
   AND EXISTS (
     SELECT 1 FROM otp_operation_authorizations a
      WHERE a.challenge_id = otp_challenges.id AND a.consumed_at IS NULL
   );

UPDATE otp_operation_authorizations
   SET expires_at = LEAST(expires_at, now())
 WHERE consumed_at IS NULL
   AND challenge_id IN (
     SELECT id FROM otp_challenges WHERE verification_state = 'ambiguous'
   );

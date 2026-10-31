-- Audit retention: audit_events stays append-only for every update and for any
-- delete, except an explicit retention run (SET LOCAL w13.audit_retention='on')
-- removing rows older than the 90-day floor. The floor lives here so that no
-- application bug or mistyped setting can erase recent security history.
CREATE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('w13.audit_retention', true) = 'on'
     AND OLD.created_at < now() - interval '90 days' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Historical records are append-only' USING ERRCODE = '23514';
END;
$$;
DROP TRIGGER audit_append_only ON audit_events;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
CREATE INDEX audit_created ON audit_events(created_at);

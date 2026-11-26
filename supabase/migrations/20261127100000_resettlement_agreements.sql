CREATE TABLE public.resettlement_agreements (
  case_id bigint NOT NULL REFERENCES public.resettlement_cases(id),
  kind text NOT NULL CHECK (kind IN ('PRIMARY', 'ADDENDUM')),
  agreement_number text NOT NULL CHECK (length(trim(agreement_number)) BETWEEN 1 AND 120),
  signed_on date NOT NULL,
  notary_office text NOT NULL CHECK (length(trim(notary_office)) BETWEEN 1 AND 240),
  basis text NOT NULL CHECK (length(trim(basis)) BETWEEN 1 AND 2000),
  notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  recorded_by integer NOT NULL REFERENCES public.users(id),
  PRIMARY KEY (case_id, agreement_number, signed_on)
);

CREATE UNIQUE INDEX resettlement_single_primary_agreement
  ON public.resettlement_agreements (case_id) WHERE kind = 'PRIMARY';

ALTER TABLE public.resettlement_agreements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.resettlement_agreements FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.resettlement_agreements TO service_role;

CREATE FUNCTION public.record_resettlement_agreement(
  p_case_id bigint, p_actor_id integer, p_kind text, p_number text,
  p_signed_on date, p_notary text, p_basis text, p_notes text
) RETURNS public.resettlement_agreements
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  v_case_status text;
  v_agreement public.resettlement_agreements;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.users WHERE id = p_actor_id AND is_active = 1 AND role = 'ADMIN'
  ) THEN
    RAISE EXCEPTION 'INVALID_ACTOR';
  END IF;

  SELECT status INTO v_case_status FROM public.resettlement_cases WHERE id = p_case_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RESETTLEMENT_NOT_FOUND';
  END IF;
  IF v_case_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'RESETTLEMENT_NOT_DRAFT';
  END IF;

  SELECT * INTO v_agreement FROM public.resettlement_agreements
    WHERE case_id = p_case_id AND agreement_number = p_number AND signed_on = p_signed_on;
  IF FOUND THEN
    IF (v_agreement.kind, v_agreement.notary_office, v_agreement.basis, v_agreement.notes)
       IS DISTINCT FROM (p_kind, p_notary, p_basis, p_notes) THEN
      RAISE EXCEPTION 'AGREEMENT_CONFLICT';
    END IF;
    RETURN v_agreement;
  END IF;
  IF p_kind = 'ADDENDUM' AND NOT EXISTS (
    SELECT 1 FROM public.resettlement_agreements WHERE case_id = p_case_id AND kind = 'PRIMARY'
  ) THEN
    RAISE EXCEPTION 'PRIMARY_AGREEMENT_REQUIRED';
  END IF;

  INSERT INTO public.resettlement_agreements
    (case_id, kind, agreement_number, signed_on, notary_office, basis, notes, recorded_by)
  VALUES (p_case_id, p_kind, p_number, p_signed_on, p_notary, p_basis, p_notes, p_actor_id)
  RETURNING * INTO v_agreement;
  RETURN v_agreement;
END;
$$;

REVOKE ALL ON FUNCTION public.record_resettlement_agreement(bigint, integer, text, text, date, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_resettlement_agreement(bigint, integer, text, text, date, text, text, text)
  TO service_role;

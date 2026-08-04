from app.services.form_service_registry import match_service_alias, normalize_service_message


def test_income_certificate_typo_routes_to_supported_service():
    match = match_service_alias("incom certificate apply karna hai")

    assert match is not None
    assert match[0] == "bihar.income-certificate"
    assert match[1] >= 0.78


def test_hinglish_income_certificate_routes_to_bihar_service():
    match = match_service_alias("Bihar ka aay praman patra apply karo")

    assert match is not None
    assert match[0] == "bihar.income-certificate"


def test_common_spelling_errors_are_normalized_before_matching():
    normalized = normalize_service_message("INCOM certficate aply karna hai")

    assert "income certificate apply" in normalized


def test_unknown_generic_form_is_not_misrepresented_as_supported():
    assert match_service_alias("random xyz university form apply karo") is None

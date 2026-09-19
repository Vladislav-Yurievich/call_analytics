import copy
import unittest

from analyze_calls_strict import ANALYSIS_SCHEMA_VERSION, CHECK_KEYS, PRE_MOSCOW_SCHEMA_VERSION, QUALITY_WEIGHTS, contains_cjk, normalize_analysis, normalize_red_flags, system_prompt_for_schema, valid_cached_result


class StrictAnalysisTests(unittest.TestCase):
    def result(self, category="new_order"):
        record = {"file_name": "test.mp3", "text": "Test transcript"}
        analysis = normalize_analysis({"call_category": category, "source_quality": "good",
                                       "checks": {key: {"status": "no"} for key in CHECK_KEYS}})
        return {"record": record, "analysis": analysis}

    def test_valid_result_and_weights(self):
        result = self.result()
        self.assertTrue(valid_cached_result(result, result["record"]))
        self.assertEqual(QUALITY_WEIGHTS["asked_client_name"], 3)
        self.assertEqual(QUALITY_WEIGHTS["client_name_learned_or_used"], 5)
        self.assertEqual(sum(QUALITY_WEIGHTS.values()), 100)

    def test_chinese_nested_and_supplementary(self):
        for phrase in ("\u901a\u8bdd\u5185\u5bb9", "\U00020000"):
            result = self.result()
            result["analysis"]["checks"]["asked_client_name"]["comment"] = phrase
            self.assertTrue(contains_cjk(result["analysis"]))
            self.assertFalse(valid_cached_result(result))

    def test_changed_source_rejected(self):
        result = self.result()
        changed = copy.deepcopy(result["record"])
        changed["text"] += " changed"
        self.assertFalse(valid_cached_result(result, changed))

    def test_wrong_score_rejected(self):
        result = self.result()
        result["analysis"]["earned_points"] += 1
        self.assertFalse(valid_cached_result(result))

    def test_malformed_cache_rejected(self):
        for value in (None, [], {}, {"analysis": {}}, {"analysis": {"schema_version": "calls-1.1"}}):
            self.assertFalse(valid_cached_result(value))

    def test_pre_moscow_profile_omits_legal_entity_rule(self):
        prompt = system_prompt_for_schema(PRE_MOSCOW_SCHEMA_VERSION)
        self.assertNotIn("unauthorized_legal_entity_offer", prompt)
        self.assertNotIn("РАЗРЕШЁННЫЕ ЮРИДИЧЕСКИЕ ЛИЦА", prompt)
        analysis = normalize_analysis(
            {"call_category": "new_order", "source_quality": "good", "checks": {}},
            schema_version=PRE_MOSCOW_SCHEMA_VERSION,
        )
        self.assertEqual(analysis["schema_version"], PRE_MOSCOW_SCHEMA_VERSION)
        self.assertNotIn("unauthorized_legal_entity_offer", analysis["red_flags"])

    def test_internal_excluded(self):
        result = self.result("internal_operational")
        self.assertTrue(valid_cached_result(result))
        self.assertIsNone(result["analysis"]["quality_percent"])
        self.assertEqual(result["analysis"]["applicable_points"], 0)
        self.assertTrue(all(item["status"] == "not_applicable" for item in result["analysis"]["checks"].values()))

    def test_organization_cards_are_not_payment_flags(self):
        for evidence in (
            "\u041f\u0440\u0438\u0448\u043b\u0438\u0442\u0435 \u043a\u0430\u0440\u0442\u0443 \u043f\u0440\u0435\u0434\u043f\u0440\u0438\u044f\u0442\u0438\u044f",
            "\u041a\u0430\u0440\u0442\u043e\u0447\u043a\u0430 \u043e\u0440\u0433\u0430\u043d\u0438\u0437\u0430\u0446\u0438\u0438 \u0434\u043b\u044f \u043e\u043f\u043b\u0430\u0442\u044b \u043f\u043e \u0441\u0447\u0435\u0442\u0443",
        ):
            flags = normalize_red_flags({"third_party_card_transfer": {"status": "yes", "evidence": evidence}}, {})
            self.assertEqual(flags["third_party_card_transfer"]["status"], "no")

    def test_explicit_personal_card_payment_is_retained(self):
        evidence = "\u041f\u0435\u0440\u0435\u0432\u0435\u0441\u0442\u0438 \u0434\u0435\u043d\u044c\u0433\u0438 \u043d\u0430 \u043c\u043e\u044e \u043b\u0438\u0447\u043d\u0443\u044e \u043a\u0430\u0440\u0442\u0443"
        flags = normalize_red_flags({"third_party_card_transfer": {"status": "yes", "evidence": evidence}}, {})
        self.assertEqual(flags["third_party_card_transfer"]["status"], "yes")

    def test_approved_legal_entities_are_not_flagged(self):
        for entity in ("ООО Железная-Мебель", "Металлическая мебель", "ИП Ядрышникова Т.О."):
            flags = normalize_red_flags({"unauthorized_legal_entity_offer": {
                "status": "yes", "detected_entity": entity,
                "evidence": f"Оформим счёт от {entity}",
            }}, {})
            self.assertEqual(flags["unauthorized_legal_entity_offer"]["status"], "no")

    def test_explicit_outside_legal_entity_offer_is_retained(self):
        flags = normalize_red_flags({"unauthorized_legal_entity_offer": {
            "status": "yes", "detected_entity": "ООО Интендант",
            "evidence": "Можем оформить покупку на юридическое лицо Интендант",
        }}, {})
        self.assertEqual(flags["unauthorized_legal_entity_offer"]["status"], "yes")
        self.assertEqual(flags["unauthorized_legal_entity_offer"]["detected_entity"], "ООО Интендант")

    def test_generic_or_unsupported_entity_is_rejected(self):
        flags = normalize_red_flags({"unauthorized_legal_entity_offer": {
            "status": "yes", "detected_entity": "ИО",
            "evidence": "Если на юрлицо счёт выставлять?",
        }}, {})
        self.assertEqual(flags["unauthorized_legal_entity_offer"]["status"], "no")

    def test_new_cache_requires_current_schema_when_requested(self):
        result = self.result()
        self.assertEqual(result["analysis"]["schema_version"], ANALYSIS_SCHEMA_VERSION)
        self.assertTrue(valid_cached_result(result, result["record"], ANALYSIS_SCHEMA_VERSION))


if __name__ == "__main__":
    unittest.main()

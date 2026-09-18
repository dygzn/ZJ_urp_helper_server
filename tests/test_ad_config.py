import unittest
from unittest.mock import patch
from services.ad_config_service import get_ad_config, validate_ad_config


class AdConfigTests(unittest.TestCase):
    def test_default_disabled(self):
        with patch('services.ad_config_service.get_config', return_value={}):
            self.assertFalse(get_ad_config()['enabled'])

    def test_enabled_requires_content(self):
        with self.assertRaises(ValueError):
            validate_ad_config({'enabled': True})

    def test_rejects_unsafe_urls_and_non_boolean(self):
        for value in [{'enabled': 'false'}, {'image_url': 'javascript:alert(1)'}, {'button_url': '//evil.test'}]:
            with self.assertRaises(ValueError):
                validate_ad_config(value)

    def test_accepts_complete_ad(self):
        data = validate_ad_config({'enabled': True, 'title': '活动', 'summary': '简介', 'body': '第一段\n第二段', 'button_url': 'https://example.com'})
        self.assertEqual(data['body'], '第一段\n第二段')


if __name__ == '__main__':
    unittest.main()

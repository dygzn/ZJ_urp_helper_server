import subprocess
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class UrpEntrypointRemovalTests(unittest.TestCase):
    def test_legacy_top_level_module_is_no_longer_importable(self):
        result = subprocess.run(
            [sys.executable, '-c', 'import URP'],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn('ModuleNotFoundError', result.stderr)

    def test_canonical_urp_package_still_exports_public_classes(self):
        from urp import URP_login, URP_query

        self.assertEqual(URP_login.__module__, 'urp.login')
        self.assertEqual(URP_query.__module__, 'urp.query')


if __name__ == '__main__':
    unittest.main()

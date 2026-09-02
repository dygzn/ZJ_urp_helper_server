import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PAGE = ROOT / "templates" / "index.html"
STYLESHEET = ROOT / "static" / "css" / "style.css"
SCRIPT = ROOT / "static" / "js" / "main.js"
DETAIL_PAGE = ROOT / "templates" / "ad_detail.html"
DETAIL_SCRIPT = ROOT / "static" / "js" / "ad-detail.js"
APP = ROOT / "app.py"


class HeaderAdPreviewTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(PAGE.exists(), f"预览页面不存在: {PAGE}")
        self.html = PAGE.read_text(encoding="utf-8")
        self.css = STYLESHEET.read_text(encoding="utf-8")
        self.js = SCRIPT.read_text(encoding="utf-8")
        self.detail_html = (
            DETAIL_PAGE.read_text(encoding="utf-8") if DETAIL_PAGE.exists() else ""
        )
        self.detail_js = (
            DETAIL_SCRIPT.read_text(encoding="utf-8") if DETAIL_SCRIPT.exists() else ""
        )
        self.app_source = APP.read_text(encoding="utf-8")

    def test_main_ad_is_a_link_to_the_detail_page(self):
        header = re.search(
            r'<header class="header">(?P<body>.*?)</header>',
            self.html,
            re.DOTALL,
        )
        self.assertIsNotNone(header)
        header_html = header.group("body")
        title_index = header_html.index('id="page-title"')
        ad_index = header_html.index('id="header-ad-slot"')
        status_index = header_html.index('id="login-status-indicator"')

        self.assertLess(title_index, ad_index)
        self.assertLess(ad_index, status_index)
        self.assertIn('aria-label="广告位"', header_html)
        self.assertRegex(
            header_html,
            r'<a[^>]+class="header-ad-main"[^>]+href="/ad-detail"',
        )
        self.assertIn("学生优惠购机活动，奖励最高140元！", header_html)
        self.assertIn("点此查看详情", header_html)
        self.assertNotIn("学生优惠购机奖励", header_html)
        self.assertNotIn("手机/平板 30-40 元 · 电脑 50-100 元", header_html)

    def test_ad_slot_is_a_normal_flow_middle_column(self):
        header_css = re.search(
            r"\.header\s*\{(?P<body>.*?)\}", self.css, re.DOTALL
        )
        ad_css = re.search(
            r"\.header-ad-slot\s*\{(?P<body>.*?)\}", self.css, re.DOTALL
        )

        self.assertIsNotNone(header_css)
        self.assertIn("display: flex", header_css.group("body"))
        self.assertIsNotNone(ad_css)
        self.assertIn("position: relative", ad_css.group("body"))
        self.assertNotIn("position: fixed", ad_css.group("body"))
        self.assertNotIn("position: sticky", ad_css.group("body"))
        self.assertRegex(self.css, r"@media[\s\S]*?\.header-ad-slot")

    def test_ad_controls_include_temporary_and_permanent_close(self):
        self.assertIn('data-ad-action="options"', self.html)
        self.assertIn('data-ad-action="dismiss"', self.html)
        self.assertIn('data-ad-action="never-show"', self.html)
        self.assertIn('data-ad-action="restore"', self.html)
        self.assertIn("headerAdNeverShowKey", self.js)
        self.assertIn("sessionStorage", self.js)
        self.assertIn("localStorage", self.js)

    def test_detail_page_describes_student_discount_rewards(self):
        self.assertTrue(self.detail_html, f"详情页不存在: {DETAIL_PAGE}")
        self.assertNotIn(
            "本页面是商业广告，不代表 URP、学校、京东、淘宝或抖音官方背书。",
            self.detail_html,
        )
        self.assertIn("学生优惠", self.detail_html)
        self.assertIn("京东", self.detail_html)
        self.assertIn("淘宝", self.detail_html)
        self.assertIn("抖音", self.detail_html)
        self.assertIn("30-40 元", self.detail_html)
        self.assertIn("50-100 元", self.detail_html)
        self.assertIn("商家微信", self.detail_html)
        self.assertIn("订单", self.detail_html)
        self.assertIn("购机款", self.detail_html)
        self.assertIn("指定收货地址", self.detail_html)
        self.assertIn("收到货", self.detail_html)
        self.assertIn("国补", self.detail_html)
        self.assertIn("学生优惠资格", self.detail_html)
        self.assertIn("今年有更换设备需求", self.detail_html)
        self.assertNotIn("今年没有更换设备需求", self.detail_html)
        self.assertIn("账号密码", self.detail_html)
        self.assertIn("验证码", self.detail_html)

    def test_detail_page_leads_with_no_advance_funding_notice(self):
        hero = re.search(
            r'<section[^>]+class="ad-detail-hero"(?P<body>.*?)</section>',
            self.detail_html,
            re.DOTALL,
        )
        self.assertIsNotNone(hero)
        hero_html = hero.group("body")
        self.assertIn('class="ad-detail-no-advance"', hero_html)
        funding_index = hero_html.index('class="ad-detail-no-advance"')
        title_index = hero_html.index("<h1")

        self.assertLess(funding_index, title_index)
        self.assertIn("全程无需任何垫资", hero_html)
        self.assertIn("商家发单时同步提供对应购机款", hero_html)
        self.assertIn("未确认购买款到账前不要下单", self.detail_html)

    def test_detail_page_highlights_wechat_and_source_remark(self):
        hero = re.search(
            r'<section[^>]+class="ad-detail-hero"(?P<body>.*?)</section>',
            self.detail_html,
            re.DOTALL,
        )
        contact = re.search(
            r'<section[^>]+id="ad-detail-contact"(?P<body>.*?)</section>',
            self.detail_html,
            re.DOTALL,
        )
        notice_index = self.detail_html.index('class="ad-detail-notice"')
        contact_index = self.detail_html.index('id="ad-detail-contact"')
        footer_index = self.detail_html.index('class="ad-detail-footer"')

        self.assertIsNotNone(hero)
        self.assertIsNotNone(contact)
        self.assertIn("请滑到页面最下方查看联系方式", hero.group("body"))
        self.assertNotIn('id="ad-detail-contact"', hero.group("body"))
        self.assertLess(notice_index, contact_index)
        self.assertLess(contact_index, footer_index)
        contact_html = contact.group("body")

        self.assertIn("商家微信", contact_html)
        self.assertIn('data-copy-value="xttlqw_0329"', contact_html)
        self.assertIn("meizhenxin", contact_html)
        self.assertIn('data-copy-value="meizhenxin"', contact_html)
        self.assertIn("来自本网站", contact_html)
        self.assertIn("以商家当期规则为准", contact_html)
        self.assertIn('aria-live="polite"', contact_html)
        self.assertIn('/static/js/service-status-ui.js', self.detail_html)
        self.assertIn('/static/js/ad-detail.js', self.detail_html)
        self.assertIn("ServiceStatusUI", self.detail_js)
        self.assertIn("copyText", self.detail_js)
        self.assertIn("data-copy-state", self.detail_js)

    def test_detail_page_has_a_flask_route(self):
        self.assertIn("@app.route('/ad-detail')", self.app_source)
        self.assertIn("render_template('ad_detail.html')", self.app_source)


if __name__ == "__main__":
    unittest.main()

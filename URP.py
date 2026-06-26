# 兼容入口：保持 `from URP import URP_login, URP_query` 不变
from urp.login import URP_login
from urp.query import URP_query

__all__ = ["URP_login", "URP_query"]

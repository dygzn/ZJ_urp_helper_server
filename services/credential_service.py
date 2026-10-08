"""教务凭据加密；数据库和账号查询不需要接触解密后的密码。"""
import os

from cryptography.fernet import Fernet, InvalidToken


class CredentialError(RuntimeError):
    pass


class CredentialCipher:
    PREFIX = 'fernet:v1:'

    @staticmethod
    def configured():
        return bool(os.environ.get('URP_CREDENTIAL_KEY', '').strip())

    @classmethod
    def is_encrypted(cls, value):
        return isinstance(value, str) and value.startswith(cls.PREFIX)

    def _cipher(self):
        key = os.environ.get('URP_CREDENTIAL_KEY', '').strip()
        if not key:
            raise CredentialError('服务器尚未配置 URP_CREDENTIAL_KEY，不能安全保存教务密码')
        try:
            return Fernet(key.encode('ascii'))
        except (ValueError, UnicodeError) as exc:
            raise CredentialError('URP_CREDENTIAL_KEY 格式无效') from exc

    def encrypt(self, password):
        """输入是新提交的明文，即使它恰好包含密文前缀也要正常加密。"""
        return self.PREFIX + self._cipher().encrypt(password.encode('utf-8')).decode('ascii')

    def validate_configuration(self):
        """保存账号前检查配置，不接触用户密码或改变已有密文。"""
        self._cipher()

    def ensure_encrypted(self, stored_password):
        """迁移已存储凭据：保留空占位和现有密文，避免二次加密。"""
        if not stored_password or self.is_encrypted(stored_password):
            return stored_password
        return self.encrypt(stored_password)

    def decrypt(self, stored_password):
        """只在登录重放时调用；旧明文兼容，密文解密失败绝不当作明文。"""
        if not self.is_encrypted(stored_password):
            return stored_password
        try:
            token = stored_password[len(self.PREFIX):].encode('ascii')
            return self._cipher().decrypt(token).decode('utf-8')
        except (InvalidToken, UnicodeError) as exc:
            raise CredentialError('已保存的教务密码无法解密，请检查加密密钥') from exc

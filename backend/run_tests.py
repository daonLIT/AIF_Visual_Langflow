"""pytest 가 없어도 실행할 수 있는 테스트 러너: python run_tests.py"""
import os
import sys
import unittest

# 실제 .env(live 설정)를 읽지 않고 테스트한다.
os.environ["AIF_SKIP_DOTENV"] = "1"

suite = unittest.defaultTestLoader.discover("tests")
result = unittest.TextTestRunner(verbosity=1).run(suite)
sys.exit(0 if result.wasSuccessful() else 1)

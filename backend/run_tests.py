"""pytest 가 없어도 실행할 수 있는 테스트 러너: python run_tests.py"""
import sys
import unittest

suite = unittest.defaultTestLoader.discover("tests")
result = unittest.TextTestRunner(verbosity=1).run(suite)
sys.exit(0 if result.wasSuccessful() else 1)

# Global Claude Instructions

<!-- Этот файл применяется ко всем пользователям как ~/.claude/CLAUDE.md -->

## Доступные инструменты тестирования

### C

```
check         — юнит-тесты (Suite / TCase / ck_assert_*)
valgrind      — утечки памяти: valgrind --leak-check=full ./app
gcov + lcov   — покрытие: компилируй с -fprofile-arcs -ftest-coverage
gcovr         — HTML-отчёт покрытия: gcovr --html-details out/
```

### C++

```
gtest / gmock — Google Test: #include <gtest/gtest.h>, линковать -lgtest -lgmock -lpthread
                Запуск: ./my_tests  или  ctest --test-dir build/
cppunit       — CppUnit: #include <cppunit/...>, линковать -lcppunit
valgrind      — анализ памяти (аналогично C)
lcov / gcovr  — покрытие (аналогично C)

CMake: find_package(GTest REQUIRED); target_link_libraries(t GTest::gtest_main GTest::gmock)
```

### Qt (QTest)

```
QTest — встроен в Qt5; в .pro: QT += testlib; CONFIG += testcase
        Класс теста наследует QObject, методы-слоты с префиксом test*
        Запуск: ./my_qt_test  или  make check
```

### Python

```
pytest              — запуск тестов:  pytest / pytest -v
pytest-cov          — покрытие:       pytest --cov=src --cov-report=html
pytest-xdist        — параллельно:    pytest -n auto
coverage            — отдельно:       coverage run -m pytest && coverage report
unittest-xml-report — XML для CI:     python -m xmlrunner ...
```

### Общие советы

- Для C/C++ всегда компилируй с `-Wall -Wextra` и прогоняй через `valgrind`.
- Покрытие для C/C++: добавь флаги `--coverage` (gcc) или `-fprofile-instr-generate -fcoverage-mapping` (clang).
- Для Python используй `pytest` — он обнаруживает тесты автоматически по шаблону `test_*.py` / `*_test.py`.
- Google Test библиотеки находятся в `/usr/local/lib` (libgtest.so, libgmock.so).

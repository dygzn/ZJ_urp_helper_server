import anthropic
import re
from docx import Document
from docx.shared import Pt, Inches
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from docx.oxml import OxmlElement
import os
import uuid

# API 配置
API_KEY = os.environ.get('API_KEY', 'sk-ULAwi9TpkK5EygJPKxvsVTTX1gA6EUjF7oWa7KoYwQ13ljV2')
API_BASE_URL = 'https://api.mcxhm.cn'

# 字号定义（Word字号对应磅值）
FONT_SIZE_2 = Pt(22)      # 二号 - 论文标题
FONT_SIZE_3 = Pt(16)      # 三号 - 章标题（二级标题）
FONT_SIZE_4 = Pt(14)      # 四号 - 节标题（三级标题）
FONT_SIZE_SMALL_4 = Pt(12)  # 小四 - 正文、小节标题（四级标题）
FONT_SIZE_5 = Pt(10.5)    # 五号 - 表格名、图名
FONT_SIZE_SMALL_5 = Pt(9)   # 小五 - 表格文字、页眉页脚

# 论文模板定义
PAPER_TEMPLATES = {
    'simple': {
        'name': '简单报告',
        'sections': [
            {'key': 'abstract', 'title': '摘要', 'ratio': 0.08, 'min': 150},
            {'key': 'keywords', 'title': '关键词', 'ratio': 0, 'min': 0},
            {'key': 'introduction', 'title': '一、引言', 'ratio': 0.15, 'min': 200},
            {'key': 'main_content', 'title': '二、正文', 'ratio': 0.65, 'min': 500},
            {'key': 'conclusion', 'title': '三、结论', 'ratio': 0.10, 'min': 150},
            {'key': 'references', 'title': '参考文献', 'ratio': 0, 'min': 0},
        ]
    },
    'standard': {
        'name': '标准学术论文',
        'sections': [
            {'key': 'abstract', 'title': '摘要', 'ratio': 0.06, 'min': 150},
            {'key': 'keywords', 'title': '关键词', 'ratio': 0, 'min': 0},
            {'key': 'introduction', 'title': '一、引言', 'ratio': 0.12, 'min': 200},
            {'key': 'literature', 'title': '二、文献综述', 'ratio': 0.18, 'min': 300},
            {'key': 'method', 'title': '三、研究方法', 'ratio': 0.18, 'min': 300},
            {'key': 'results', 'title': '四、结果分析', 'ratio': 0.28, 'min': 400},
            {'key': 'conclusion', 'title': '五、结论', 'ratio': 0.10, 'min': 150},
            {'key': 'references', 'title': '参考文献', 'ratio': 0, 'min': 0},
        ]
    },
    'graduation': {
        'name': '毕业论文',
        'sections': [
            {'key': 'abstract', 'title': '摘要', 'ratio': 0.05, 'min': 200},
            {'key': 'keywords', 'title': '关键词', 'ratio': 0, 'min': 0},
            {'key': 'introduction', 'title': '一、绪论', 'ratio': 0.08, 'min': 200},
            {'key': 'literature', 'title': '二、文献综述', 'ratio': 0.15, 'min': 400},
            {'key': 'theory', 'title': '三、理论基础', 'ratio': 0.12, 'min': 300},
            {'key': 'design', 'title': '四、研究设计', 'ratio': 0.15, 'min': 400},
            {'key': 'analysis', 'title': '五、实证分析', 'ratio': 0.25, 'min': 500},
            {'key': 'conclusion', 'title': '六、结论与建议', 'ratio': 0.12, 'min': 300},
            {'key': 'references', 'title': '参考文献', 'ratio': 0, 'min': 0},
        ]
    },
    'experiment': {
        'name': '实验报告',
        'sections': [
            {'key': 'abstract', 'title': '摘要', 'ratio': 0.08, 'min': 100},
            {'key': 'keywords', 'title': '关键词', 'ratio': 0, 'min': 0},
            {'key': 'purpose', 'title': '一、实验目的', 'ratio': 0.10, 'min': 100},
            {'key': 'principle', 'title': '二、实验原理', 'ratio': 0.20, 'min': 200},
            {'key': 'procedure', 'title': '三、实验步骤', 'ratio': 0.25, 'min': 300},
            {'key': 'results', 'title': '四、实验结果', 'ratio': 0.25, 'min': 300},
            {'key': 'conclusion', 'title': '五、结论', 'ratio': 0.10, 'min': 100},
            {'key': 'references', 'title': '参考文献', 'ratio': 0, 'min': 0},
        ]
    },
    'research': {
        'name': '调研报告',
        'sections': [
            {'key': 'abstract', 'title': '摘要', 'ratio': 0.06, 'min': 150},
            {'key': 'keywords', 'title': '关键词', 'ratio': 0, 'min': 0},
            {'key': 'introduction', 'title': '一、引言', 'ratio': 0.10, 'min': 150},
            {'key': 'background', 'title': '二、调研背景', 'ratio': 0.12, 'min': 200},
            {'key': 'method', 'title': '三、调研方法', 'ratio': 0.15, 'min': 250},
            {'key': 'results', 'title': '四、调研结果', 'ratio': 0.25, 'min': 400},
            {'key': 'discussion', 'title': '五、分析讨论', 'ratio': 0.18, 'min': 300},
            {'key': 'conclusion', 'title': '六、结论建议', 'ratio': 0.10, 'min': 150},
            {'key': 'references', 'title': '参考文献', 'ratio': 0, 'min': 0},
        ]
    }
}


def get_available_templates():
    """获取可用的模板列表"""
    return {key: {'name': val['name'], 'sections': [s['title'] for s in val['sections'] if s['key'] not in ['keywords']]}
            for key, val in PAPER_TEMPLATES.items()}


def generate_paper_content(title, subject, requirements, keywords, wordcount, template='simple'):
    """
    调用 API 根据模板分段生成论文内容
    """
    if not API_KEY:
        raise ValueError("请设置 API_KEY")

    wc = int(wordcount)

    # 获取模板配置
    tmpl = PAPER_TEMPLATES.get(template, PAPER_TEMPLATES['simple'])
    sections = tmpl['sections']

    # 创建 Anthropic 客户端（使用第三方供应商）
    client = anthropic.Anthropic(api_key=API_KEY, base_url=API_BASE_URL)

    def call_api(prompt, max_tokens=4000):
        message = client.messages.create(
            model='claude-sonnet-4-5-20250929',
            max_tokens=max_tokens,
            messages=[{'role': 'user', 'content': prompt}]
        )
        return message.content[0].text

    context = f"论文标题：{title}\n学科方向：{subject if subject else '不限'}\n内容要求：{requirements if requirements else '无特殊要求'}\n论文总字数：{wc}字\n\n注意：不要使用LaTeX公式语法（如$...$），如需表达公式请用纯文字描述或简单符号（如：x的平方写作x²，求和写作Σ等）。"

    # 章节生成提示词模板
    # 引用标注说明：要求按顺序从[1]开始依次标注，不能跳跃或重复
    citation_rule = '文献引用标注必须按顺序从[1]开始依次递增（如[1]、[2]、[3]...），不能跳跃或重复编号。'
    section_prompts = {
        'abstract': '请为这篇论文生成摘要，约{words}字。概括研究目的、方法、结果和结论。只输出摘要正文。',
        'keywords': '请为这篇论文生成3-5个关键词，用分号分隔。{user_keywords}只输出关键词。',
        'introduction': f'请为这篇论文生成引言部分，约{{words}}字。介绍研究背景、目的和意义。在适当位置添加文献引用标注。{citation_rule}只输出正文内容，不要输出标题。',
        'literature': f'请为这篇论文生成文献综述部分，约{{words}}字。梳理相关研究进展和现状。在适当位置添加文献引用标注。{citation_rule}只输出正文内容，不要输出标题。',
        'method': f'请为这篇论文生成研究方法部分，约{{words}}字。详细说明研究采用的方法和技术路线。在适当位置添加文献引用标注。{citation_rule}只输出正文内容，不要输出标题。',
        'results': f'请为这篇论文生成结果分析部分，约{{words}}字。展示研究结果并进行分析讨论。分成多个小节，每个小节有小标题。在适当位置添加文献引用标注。{citation_rule}只输出正文内容，不要输出大标题。',
        'conclusion': '请为这篇论文生成结论部分，约{words}字。总结研究成果，指出局限性，展望未来研究方向。只输出正文内容，不要输出标题。',
        'references': '请为这篇论文生成8-12条参考文献，格式规范（GB/T 7714格式）。每条参考文献前面加上序号[1]、[2]等，序号必须从[1]开始依次递增，与正文中的引用标注对应。只输出参考文献列表，每条一行。',
        'main_content': f'请为这篇论文生成正文/主要内容部分，约{{words}}字。分成多个小节，每个小节有小标题，内容充实具体。在适当位置添加文献引用标注。{citation_rule}只输出正文内容，不要输出大标题。',
        'theory': f'请为这篇论文生成理论基础部分，约{{words}}字。阐述相关理论框架和概念。在适当位置添加文献引用标注。{citation_rule}只输出正文内容，不要输出标题。',
        'design': '请为这篇论文生成研究设计部分，约{words}字。说明研究对象、数据来源、变量设计等。只输出正文内容，不要输出标题。',
        'analysis': f'请为这篇论文生成实证分析部分，约{{words}}字。展示数据分析过程和结果。分成多个小节。在适当位置添加文献引用标注。{citation_rule}只输出正文内容，不要输出大标题。',
        'purpose': '请为这篇论文生成实验目的部分，约{words}字。说明本实验要达到的目标。只输出正文内容，不要输出标题。',
        'principle': f'请为这篇论文生成实验原理部分，约{{words}}字。阐述实验的理论依据和原理。在适当位置添加文献引用标注。{citation_rule}只输出正文内容，不要输出标题。',
        'procedure': '请为这篇论文生成实验步骤部分，约{words}字。详细描述实验操作流程。可分步骤列出。只输出正文内容，不要输出标题。',
        'background': f'请为这篇论文生成调研背景部分，约{{words}}字。说明调研的背景和必要性。在适当位置添加文献引用标注。{citation_rule}只输出正文内容，不要输出标题。',
        'discussion': f'请为这篇论文生成分析讨论部分，约{{words}}字。对调研结果进行深入分析和讨论。在适当位置添加文献引用标注。{citation_rule}只输出正文内容，不要输出标题。',
    }

    try:
        # 计算各部分字数
        section_words = {}
        for sec in sections:
            if sec['ratio'] > 0:
                section_words[sec['key']] = max(int(wc * sec['ratio']), sec['min'])

        # 生成各部分内容（参考文献最后生成）
        generated = {}
        sections_without_refs = [sec for sec in sections if sec['key'] != 'references']
        ref_section = next((sec for sec in sections if sec['key'] == 'references'), None)

        for sec in sections_without_refs:
            key = sec['key']

            if key == 'keywords':
                user_kw = f'用户指定关键词：{keywords}，可在此基础上补充。' if keywords else ''
                prompt = f"{context}\n\n{section_prompts[key].format(user_keywords=user_kw)}"
                generated[key] = call_api(prompt, 200)
            elif key in section_prompts:
                words = section_words.get(key, 300)
                prompt = f"{context}\n\n{section_prompts[key].format(words=words)}"
                max_tok = min(max(words * 3, 1000), 6000)
                generated[key] = call_api(prompt, max_tok)

        # 重新编号所有引用标记
        generated, total_citations = renumber_citations(generated, sections)

        # 生成参考文献（根据实际引用数量）
        if ref_section and total_citations > 0:
            ref_prompt = f"{context}\n\n请为这篇论文生成{total_citations}条参考文献，格式规范（GB/T 7714格式）。每条参考文献前面加上序号[1]、[2]等，序号必须从[1]到[{total_citations}]依次递增。只输出参考文献列表，每条一行。"
            generated['references'] = call_api(ref_prompt, 1500)

        # 组合所有部分为 markdown 格式
        content_parts = []
        for sec in sections:
            key = sec['key']
            if key in generated:
                if key == 'abstract':
                    content_parts.append(f"## 摘要\n{generated[key]}")
                elif key == 'keywords':
                    content_parts.append(f"## 关键词\n{generated[key]}")
                elif key == 'references':
                    content_parts.append(f"## 参考文献\n{generated[key]}")
                else:
                    content_parts.append(f"## {sec['title']}\n{generated[key]}")

        return '\n\n'.join(content_parts), generated, sections

    except anthropic.APIError as e:
        raise ValueError(f"API调用失败: {e}")
    except Exception as e:
        raise ValueError(f"请求失败: {str(e)}")


def generate_paper_content_with_progress(title, subject, requirements, keywords, wordcount, template='simple'):
    """
    生成论文内容的生成器版本，每完成一个章节就 yield 进度信息
    """
    if not API_KEY:
        raise ValueError("请设置 API_KEY")

    wc = int(wordcount)

    # 获取模板配置
    tmpl = PAPER_TEMPLATES.get(template, PAPER_TEMPLATES['simple'])
    sections = tmpl['sections']
    total_sections = len(sections)

    # 创建 Anthropic 客户端（使用第三方供应商）
    client = anthropic.Anthropic(api_key=API_KEY, base_url=API_BASE_URL)

    def call_api(prompt, max_tokens=4000):
        message = client.messages.create(
            model='claude-sonnet-4-5-20250929',
            max_tokens=max_tokens,
            messages=[{'role': 'user', 'content': prompt}]
        )
        return message.content[0].text

    context = f"论文标题：{title}\n学科方向：{subject if subject else '不限'}\n内容要求：{requirements if requirements else '无特殊要求'}\n论文总字数：{wc}字\n\n注意：不要使用LaTeX公式语法（如$...$），如需表达公式请用纯文字描述或简单符号（如：x的平方写作x²，求和写作Σ等）。"

    # 章节生成提示词模板
    # 引用标注说明：要求按顺序从[1]开始依次标注，不能跳跃或重复
    citation_rule = '文献引用标注必须按顺序从[1]开始依次递增（如[1]、[2]、[3]...），不能跳跃或重复编号。'
    section_prompts = {
        'abstract': '请为这篇论文生成摘要，约{words}字。概括研究目的、方法、结果和结论。只输出摘要正文。',
        'keywords': '请为这篇论文生成3-5个关键词，用分号分隔。{user_keywords}只输出关键词。',
        'introduction': f'请为这篇论文生成引言部分，约{{words}}字。介绍研究背景、目的和意义。在适当位置添加文献引用标注。{citation_rule}只输出正文内容，不要输出标题。',
        'literature': f'请为这篇论文生成文献综述部分，约{{words}}字。梳理相关研究进展和现状。在适当位置添加文献引用标注。{citation_rule}只输出正文内容，不要输出标题。',
        'method': f'请为这篇论文生成研究方法部分，约{{words}}字。详细说明研究采用的方法和技术路线。在适当位置添加文献引用标注。{citation_rule}只输出正文内容，不要输出标题。',
        'results': f'请为这篇论文生成结果分析部分，约{{words}}字。展示研究结果并进行分析讨论。分成多个小节，每个小节有小标题。在适当位置添加文献引用标注。{citation_rule}只输出正文内容，不要输出大标题。',
        'conclusion': '请为这篇论文生成结论部分，约{words}字。总结研究成果，指出局限性，展望未来研究方向。只输出正文内容，不要输出标题。',
        'references': '请为这篇论文生成8-12条参考文献，格式规范（GB/T 7714格式）。每条参考文献前面加上序号[1]、[2]等，序号必须从[1]开始依次递增，与正文中的引用标注对应。只输出参考文献列表，每条一行。',
        'main_content': f'请为这篇论文生成正文/主要内容部分，约{{words}}字。分成多个小节，每个小节有小标题，内容充实具体。在适当位置添加文献引用标注。{citation_rule}只输出正文内容，不要输出大标题。',
        'theory': f'请为这篇论文生成理论基础部分，约{{words}}字。阐述相关理论框架和概念。在适当位置添加文献引用标注。{citation_rule}只输出正文内容，不要输出标题。',
        'design': '请为这篇论文生成研究设计部分，约{words}字。说明研究对象、数据来源、变量设计等。只输出正文内容，不要输出标题。',
        'analysis': f'请为这篇论文生成实证分析部分，约{{words}}字。展示数据分析过程和结果。分成多个小节。在适当位置添加文献引用标注。{citation_rule}只输出正文内容，不要输出大标题。',
        'purpose': '请为这篇论文生成实验目的部分，约{words}字。说明本实验要达到的目标。只输出正文内容，不要输出标题。',
        'principle': f'请为这篇论文生成实验原理部分，约{{words}}字。阐述实验的理论依据和原理。在适当位置添加文献引用标注。{citation_rule}只输出正文内容，不要输出标题。',
        'procedure': '请为这篇论文生成实验步骤部分，约{words}字。详细描述实验操作流程。可分步骤列出。只输出正文内容，不要输出标题。',
        'background': f'请为这篇论文生成调研背景部分，约{{words}}字。说明调研的背景和必要性。在适当位置添加文献引用标注。{citation_rule}只输出正文内容，不要输出标题。',
        'discussion': f'请为这篇论文生成分析讨论部分，约{{words}}字。对调研结果进行深入分析和讨论。在适当位置添加文献引用标注。{citation_rule}只输出正文内容，不要输出标题。',
    }

    # 计算各部分字数
    section_words = {}
    for sec in sections:
        if sec['ratio'] > 0:
            section_words[sec['key']] = max(int(wc * sec['ratio']), sec['min'])

    # 生成各部分内容（参考文献最后生成）
    generated = {}
    sections_without_refs = [sec for sec in sections if sec['key'] != 'references']
    ref_section = next((sec for sec in sections if sec['key'] == 'references'), None)

    for i, sec in enumerate(sections_without_refs):
        key = sec['key']
        section_title = sec['title']

        # yield 开始生成某章节的进度
        yield {
            'type': 'progress',
            'current': i,
            'total': total_sections,
            'section': section_title,
            'percent': int((i / total_sections) * 100)
        }

        try:
            if key == 'keywords':
                user_kw = f'用户指定关键词：{keywords}，可在此基础上补充。' if keywords else ''
                prompt = f"{context}\n\n{section_prompts[key].format(user_keywords=user_kw)}"
                generated[key] = call_api(prompt, 200)
            elif key in section_prompts:
                words = section_words.get(key, 300)
                prompt = f"{context}\n\n{section_prompts[key].format(words=words)}"
                max_tok = min(max(words * 3, 1000), 6000)
                generated[key] = call_api(prompt, max_tok)
        except Exception as e:
            yield {
                'type': 'error',
                'message': f'生成 {section_title} 时出错: {str(e)}'
            }
            return

    # 重新编号所有引用标记
    generated, total_citations = renumber_citations(generated, sections)

    # 生成参考文献（根据实际引用数量）
    if ref_section and total_citations > 0:
        yield {
            'type': 'progress',
            'current': len(sections_without_refs),
            'total': total_sections,
            'section': '参考文献',
            'percent': int((len(sections_without_refs) / total_sections) * 100)
        }

        try:
            ref_prompt = f"{context}\n\n请为这篇论文生成{total_citations}条参考文献，格式规范（GB/T 7714格式）。每条参考文献前面加上序号[1]、[2]等，序号必须从[1]到[{total_citations}]依次递增。只输出参考文献列表，每条一行。"
            generated['references'] = call_api(ref_prompt, 1500)
        except Exception as e:
            yield {
                'type': 'error',
                'message': f'生成参考文献时出错: {str(e)}'
            }
            return

    # 组合所有部分为 markdown 格式
    content_parts = []
    for sec in sections:
        key = sec['key']
        if key in generated:
            if key == 'abstract':
                content_parts.append(f"## 摘要\n{generated[key]}")
            elif key == 'keywords':
                content_parts.append(f"## 关键词\n{generated[key]}")
            elif key == 'references':
                content_parts.append(f"## 参考文献\n{generated[key]}")
            else:
                content_parts.append(f"## {sec['title']}\n{generated[key]}")

    content = '\n\n'.join(content_parts)

    # 生成 Word 文档
    yield {
        'type': 'progress',
        'current': total_sections,
        'total': total_sections,
        'section': '正在生成文档...',
        'percent': 95
    }

    doc = create_word_document(title, generated, sections)

    # 保存文件
    output_dir = 'user_data/papers'
    os.makedirs(output_dir, exist_ok=True)
    filename = f"{uuid.uuid4().hex[:8]}_{title[:20]}.docx"
    filepath = os.path.join(output_dir, filename)
    doc.save(filepath)

    # yield 完成信息
    yield {
        'type': 'complete',
        'filepath': filepath,
        'filename': filename,
        'content': content
    }


def set_run_font(run, font_name='宋体', font_size=Pt(12)):
    """设置run的中文字体"""
    run.font.name = font_name
    run.font.size = font_size
    # 设置中文字体
    run._element.rPr.rFonts.set('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}eastAsia', font_name)


def renumber_citations(generated_sections, sections):
    """
    重新编号所有章节中的引用标记，确保全局连续
    返回：(处理后的sections字典, 引用总数)
    """
    # 收集所有需要处理的章节（排除 abstract, keywords, references��
    content_keys = [sec['key'] for sec in sections
                    if sec['key'] not in ('abstract', 'keywords', 'references')]

    # 第一遍：收集所有引用并建立映射
    citation_map = {}  # 原始编号 -> 新编号
    current_num = 1
    pattern = r'\[(\d+)\]'

    for key in content_keys:
        if key not in generated_sections:
            continue
        content = generated_sections[key]
        for match in re.finditer(pattern, content):
            old_num = match.group(1)
            if old_num not in citation_map:
                citation_map[old_num] = str(current_num)
                current_num += 1

    total_citations = current_num - 1

    # 第二遍：替换所有引用编号
    result = {}
    for key, content in generated_sections.items():
        if key in ('abstract', 'keywords', 'references'):
            result[key] = content
        else:
            # 替换引用编号
            def replace_citation(match):
                old_num = match.group(1)
                new_num = citation_map.get(old_num, old_num)
                return f'[{new_num}]'
            result[key] = re.sub(pattern, replace_citation, content)

    return result, total_citations


def add_text_with_citations(para, text, font_name='宋体', font_size=Pt(12)):
    """
    向段落添加文本，将引用标注[1]、[2]等转换为上标格式
    """
    # 匹配引用标注，如 [1], [2], [1,2], [1-3] 等
    pattern = r'\[(\d+(?:[-,]\d+)*)\]'

    last_end = 0
    for match in re.finditer(pattern, text):
        # 添加引用标注前的普通文本
        if match.start() > last_end:
            normal_text = text[last_end:match.start()]
            run = para.add_run(normal_text)
            set_run_font(run, font_name, font_size)

        # 添加引用标注（上标格式）
        citation = match.group(0)  # 包含方括号的完整标注
        citation_run = para.add_run(citation)
        set_run_font(citation_run, font_name, Pt(9))  # 上标用小字号
        citation_run.font.superscript = True  # 设置为上标

        last_end = match.end()

    # 添加最后一段普通文本
    if last_end < len(text):
        run = para.add_run(text[last_end:])
        set_run_font(run, font_name, font_size)


def is_subsection_title(line):
    """
    判断一行是否是小节标题
    匹配格式：1.1、1.2、2.1、（一）、（二）、(1)、(2) 等
    """
    line = line.strip()
    if not line:
        return False
    # 匹配 1.1、1.2、2.1 等数字小节标题
    if re.match(r'^\d+\.\d+[\s\.、]', line):
        return True
    # 匹配 （一）、（二）等中文序号
    if re.match(r'^（[一二三四五六七八九十]+）', line):
        return True
    # 匹配 (1)、(2) 等括号数字
    if re.match(r'^\(\d+\)', line):
        return True
    # 匹配纯数字开头后跟点或顿号的短标题（如 "1、xxx" 或 "1.xxx"，且总长度较短）
    if re.match(r'^\d+[\.、]\s*\S', line) and len(line) < 30:
        return True
    return False


def clean_markdown(text):
    """
    清除文本中的 markdown 标记
    """
    # 去除标题标记 ## ### 等（包括行首和行中的）
    text = re.sub(r'^#{1,6}\s+', '', text)  # 行首的#标记（至少要有一个空格）
    text = re.sub(r'^#{1,6}', '', text)     # 行首的#标记（没有空格的情况）
    # 去除加粗标记 **text** 或 __text__
    text = re.sub(r'\*\*(.+?)\*\*', r'\1', text)
    text = re.sub(r'__(.+?)__', r'\1', text)
    # 去除斜体标记 *text* 或 _text_（但不影响下划线变量名）
    text = re.sub(r'(?<!\*)\*([^*]+?)\*(?!\*)', r'\1', text)
    # 去除行内代码标记 `text`
    text = re.sub(r'`([^`]+?)`', r'\1', text)
    return text.strip()


def add_section_content(doc, content, font_name='宋体'):
    """
    处理章节内容，支持多段落和小节标题识别
    """
    # 按换行符分割成段落
    paragraphs = content.split('\n')

    for para_text in paragraphs:
        para_text = para_text.strip()
        if not para_text:
            continue

        # 清除 markdown 标记
        para_text = clean_markdown(para_text)
        if not para_text:
            continue

        if is_subsection_title(para_text):
            # 四级标题（小节标题）：小四黑体，居左，不缩进
            para = doc.add_paragraph()
            para.paragraph_format.first_line_indent = Inches(0)
            para.paragraph_format.space_before = Pt(6)
            para.paragraph_format.space_after = Pt(3)
            run = para.add_run(para_text)
            run.bold = False  # 黑体本身就是粗体效果
            set_run_font(run, '黑体', FONT_SIZE_SMALL_4)
        else:
            # 正文段落：小四宋体，首行缩进
            para = doc.add_paragraph()
            para.paragraph_format.first_line_indent = Inches(0.3)
            para.paragraph_format.line_spacing = 1.5  # 1.5倍行距
            add_text_with_citations(para, para_text, font_name, FONT_SIZE_SMALL_4)


def add_page_number(paragraph):
    """在段落中添加页码字段"""
    run = paragraph.add_run()
    fldChar1 = OxmlElement('w:fldChar')
    fldChar1.set(qn('w:fldCharType'), 'begin')

    instrText = OxmlElement('w:instrText')
    instrText.set(qn('xml:space'), 'preserve')
    instrText.text = "PAGE"

    fldChar2 = OxmlElement('w:fldChar')
    fldChar2.set(qn('w:fldCharType'), 'end')

    run._r.append(fldChar1)
    run._r.append(instrText)
    run._r.append(fldChar2)


def create_word_document(title, generated_sections, template_sections):
    """
    使用 python-docx 创建 Word 文档
    generated_sections: 生成的内容字典 {key: content}
    template_sections: 模板章节配置列表
    """
    doc = Document()

    # 设置页边距
    for section in doc.sections:
        section.top_margin = Inches(1)
        section.bottom_margin = Inches(1)
        section.left_margin = Inches(1.25)
        section.right_margin = Inches(1.25)

        # 设置页脚 - 显示页码
        footer = section.footer
        footer_para = footer.paragraphs[0]
        footer_para.alignment = WD_ALIGN_PARAGRAPH.CENTER
        add_page_number(footer_para)
        # 设置页脚字体
        for run in footer_para.runs:
            set_run_font(run, '宋体', FONT_SIZE_SMALL_5)

    # 一级标题（论文题目）：二号宋体居中
    title_para = doc.add_paragraph()
    title_run = title_para.add_run(title)
    title_run.bold = False
    set_run_font(title_run, '宋体', FONT_SIZE_2)
    title_para.alignment = WD_ALIGN_PARAGRAPH.CENTER
    title_para.space_after = Pt(24)

    # 根据模板章节顺序生成文档
    for sec in template_sections:
        key = sec['key']
        sec_title = sec['title']
        content = generated_sections.get(key, '')

        if not content:
            continue

        if key == 'abstract':
            # 摘要：小四黑体标签 + 宋体内容，不换行
            para = doc.add_paragraph()
            label_run = para.add_run('摘要：')
            label_run.bold = False
            set_run_font(label_run, '黑体', FONT_SIZE_SMALL_4)

            # 摘要内容直接跟在后面，去除换行符
            content_text = content.replace('\n', '')
            content_run = para.add_run(content_text)
            set_run_font(content_run, '宋体', FONT_SIZE_SMALL_4)
            para.paragraph_format.first_line_indent = Inches(0)
            para.paragraph_format.line_spacing = 1.5
            para.space_after = Pt(6)

        elif key == 'keywords':
            # 关键词：小四宋体
            para = doc.add_paragraph()
            label_run = para.add_run('关键词：')
            label_run.bold = True
            set_run_font(label_run, '黑体', FONT_SIZE_SMALL_4)
            content_run = para.add_run(content)
            set_run_font(content_run, '宋体', FONT_SIZE_SMALL_4)
            para.space_after = Pt(12)

        elif key == 'references':
            # 二级标题（参考文献）：三号黑体居中
            heading = doc.add_paragraph()
            heading_run = heading.add_run('参考文献')
            heading_run.bold = False
            set_run_font(heading_run, '黑体', FONT_SIZE_3)
            heading.alignment = WD_ALIGN_PARAGRAPH.CENTER
            heading.paragraph_format.space_before = Pt(12)
            heading.paragraph_format.space_after = Pt(6)

            # 参考文献列表：五号宋体
            for ref in content.split('\n'):
                ref = ref.strip()
                if ref:
                    ref_para = doc.add_paragraph()
                    ref_run = ref_para.add_run(ref)
                    set_run_font(ref_run, '宋体', FONT_SIZE_5)
                    ref_para.paragraph_format.left_indent = Inches(0.3)
                    ref_para.paragraph_format.first_line_indent = Inches(-0.3)
                    ref_para.paragraph_format.line_spacing = 1.5

        else:
            # 二级标题（章）：三号黑体居中
            heading = doc.add_paragraph()
            heading_run = heading.add_run(sec_title)
            heading_run.bold = False
            set_run_font(heading_run, '黑体', FONT_SIZE_3)
            heading.alignment = WD_ALIGN_PARAGRAPH.CENTER
            heading.paragraph_format.space_before = Pt(12)
            heading.paragraph_format.space_after = Pt(6)

            # 章节内容（支持多段落和小节标题）
            add_section_content(doc, content, '宋体')

    return doc


def generate_paper(title, subject='', requirements='', keywords='', wordcount='3000', template='simple'):
    """
    主函数：生成论文并保存为 Word 文档
    返回文件路径
    """
    # 生成内容
    content, generated_sections, template_sections = generate_paper_content(
        title, subject, requirements, keywords, wordcount, template
    )

    # 创建 Word 文档
    doc = create_word_document(title, generated_sections, template_sections)

    # 保存文件
    output_dir = 'user_data/papers'
    os.makedirs(output_dir, exist_ok=True)

    filename = f"{uuid.uuid4().hex[:8]}_{title[:20]}.docx"
    filepath = os.path.join(output_dir, filename)
    doc.save(filepath)

    return filepath, content

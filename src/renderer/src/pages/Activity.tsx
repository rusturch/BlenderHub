import PageLayout, { EmptyState } from '../components/PageLayout'
import { ActivityIcon } from '../components/Sidebar'
import { useTranslation } from '../lib/i18n'

export default function ActivityPage() {
  const { t } = useTranslation()
  return (
    <PageLayout title={t('nav.activity')}>
      <EmptyState
        icon={<ActivityIcon className="h-7 w-7" />}
        title={t('activity.emptyTitle')}
        hint={t('activity.emptyHint')}
      />
    </PageLayout>
  )
}

import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { ManagedPolicy, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { AutoScalingGroup } from 'aws-cdk-lib/aws-autoscaling';
import { AmazonLinuxGeneration, AmazonLinuxImage, InstanceClass, InstanceSize, InstanceType, UserData, Vpc } from 'aws-cdk-lib/aws-ec2';
import { ApplicationLoadBalancer, ApplicationProtocol } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Artifact, Pipeline } from 'aws-cdk-lib/aws-codepipeline';
import { CodeBuildAction, CodeDeployServerDeployAction, CodeStarConnectionsSourceAction } from 'aws-cdk-lib/aws-codepipeline-actions';
import { BuildSpec, LinuxBuildImage, Project } from 'aws-cdk-lib/aws-codebuild';
import { ServerApplication, ServerDeploymentGroup } from 'aws-cdk-lib/aws-codedeploy';

export class ReflexiveJavaEc2Stack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    let asg = createAsg(this);
    let pipeline = createPipeline(this, asg);
  }
}

function userData(): UserData {
  let userData = UserData.forLinux()
  userData.addCommands(
    'sudo yum -y update',
    'sudo yum install -y https://s3.amazonaws.com/ec2-downloads-windows/SSMAgent/latest/linux_amd64/amazon-ssm-agent.rpm',
    'sudo yum install -y java-11-amazon-corretto-headless'
  )
  return userData
}

function ec2SsmRole(stack: Stack): Role {
  let role = new Role(stack, 'Ec2SsmRole', {
    assumedBy: new ServicePrincipal('ec2.amazonaws.com')
  })
  role.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'))
  return role
}

function createAsg(stack: Stack): AutoScalingGroup {
  let vpc = new Vpc(stack, 'Vpc')
  let asg = new AutoScalingGroup(stack, 'Asg', {
    vpc: vpc,
    instanceType: InstanceType.of(InstanceClass.T2, InstanceSize.MICRO),
    machineImage: new AmazonLinuxImage({
      generation: AmazonLinuxGeneration.AMAZON_LINUX_2
    }),
    minCapacity: 1,
    maxCapacity: 1,
    desiredCapacity: 1,
    role: ec2SsmRole(stack),
    userData: userData(),
    keyName: 'stackulus'
  })

  const alb = new ApplicationLoadBalancer(stack, 'Alb', {
    loadBalancerName: 'reflexive-java-alb',
    vpc: vpc,
    internetFacing: true
  })

  const listener = alb.addListener('Listener', {
    port: 80,
  })

  listener.addTargets('Target', {
    port: 3000,
    protocol: ApplicationProtocol.HTTP,
    targets: [asg],
    healthCheck: {
      path: '/ping',
    }
  })

  listener.connections.allowDefaultPortFromAnyIpv4('Open to the world')

  asg.scaleOnRequestCount('AModestLoad', {
    targetRequestsPerMinute: 1000,
  })

  return asg;
}

function createPipeline(stack: Stack, asg: AutoScalingGroup): Pipeline {
  let pipeline = new Pipeline(stack, 'ReflexiveJavaPipeline', {
    pipelineName: 'ReflexiveJavaPipeline',
  });

  let sourceOutput = new Artifact('source');
  let sourceAction = new CodeStarConnectionsSourceAction({
    actionName: 'Github_Source',
    connectionArn: 'arn:aws:codestar-connections:us-east-1:864661773271:connection/e3868e91-bcdf-49d8-8e8e-05702f16c65d',
    owner: 'ntalbs',
    repo: 'reflexive-java',
    output: sourceOutput,
    branch: 'mainline',
    triggerOnPush: true,
  });
  let sourceStage = pipeline.addStage({
    stageName: 'Source',
    actions: [sourceAction],
  })

  let project = new Project(stack, 'Reflexive-Java-Project', {
    environment: {
      buildImage: LinuxBuildImage.AMAZON_LINUX_2_4
    },
    buildSpec: BuildSpec.fromObject({
      version: '0.2',
      phases: {
        install: {
          runtimeVersions: {
            java: 'corretto11',
          }
        },
        build: {
          commands: [
            './gradlew build',
          ]
        }
      },
      artifacts: {
        files: [
          'appspec.yml',
          'build/distributions/*',
          'scripts/*'
        ],
      }
    })
  });
  let buildOutput = new Artifact('build');
  let buildAction = new CodeBuildAction({
    actionName: 'BuildAction',
    input: sourceOutput,
    outputs: [buildOutput],
    project: project,
  });
  let buildStage = pipeline.addStage({
    stageName: 'Build',
    actions: [buildAction],
  });

  let application = new ServerApplication(stack, 'ReflexiveJavaApplication', {
    applicationName: 'ReflexiveJavaApp',
  });
  let deploymentGroup = new ServerDeploymentGroup(stack, 'ReflexiveJavaDeploymentGroup', {
    application,
    deploymentGroupName: 'ReflexiveJavaDeploymentGroup',
    autoScalingGroups: [asg],
    installAgent: true,
    ignorePollAlarmsFailure: false,
    autoRollback: {
      failedDeployment: true,
      stoppedDeployment: true,
      deploymentInAlarm: false,
    },
  });
  let deployAction = new CodeDeployServerDeployAction({
    actionName: 'DeployAction',
    deploymentGroup: deploymentGroup,
    input: buildOutput,
  });
  let deployStage = pipeline.addStage({
    stageName: 'Deploy',
    actions: [deployAction],
  });

  return pipeline;
}